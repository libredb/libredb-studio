import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SQLiteStorageProvider } from "@/lib/storage/providers/sqlite";
import type { StoredAccount } from "@/lib/storage/types";

// A real database file, unlike sqlite.test.ts: atomicity is a property of the engine, and a
// mocked transaction() would pass whether or not the two deletes shared one.

const account: StoredAccount = {
  email: "ada@example.com",
  passwordHash: "scrypt$hash",
  role: "user",
  totpSecret: null,
  totpPending: null,
  disabled: false,
  sessionVersion: 0,
  createdAt: "t",
  updatedAt: "t",
};

describe("SQLiteStorageProvider accounts", () => {
  let dir = "";
  let path = "";
  let provider: SQLiteStorageProvider;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "libredb-sqlite-accounts-"));
    path = join(dir, "store.db");
    provider = new SQLiteStorageProvider(path);
    await provider.initialize();
    await provider.insertAccount(account);
    await provider.setCollection(account.email, "connections", [{ id: "c1" }] as never);
  });

  afterEach(async () => {
    await provider.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("deleteAccount removes the account and its rows together", async () => {
    await provider.deleteAccount(account.email);
    expect(await provider.getAccount(account.email)).toBeNull();
    expect(await provider.getCollection(account.email, "connections")).toBeNull();
  });

  test("a failed row delete leaves the account in place instead of orphaning its rows", async () => {
    const side = new Database(path);
    side.exec(
      "CREATE TRIGGER refuse_row_delete BEFORE DELETE ON user_storage BEGIN SELECT RAISE(ABORT, 'row delete refused'); END;",
    );
    side.close();

    await expect(provider.deleteAccount(account.email)).rejects.toThrow(/row delete refused/);
    expect((await provider.getAccount(account.email))?.email).toBe(account.email);
    expect(await provider.getCollection(account.email, "connections")).toEqual([{ id: "c1" }] as never);
  });
});
