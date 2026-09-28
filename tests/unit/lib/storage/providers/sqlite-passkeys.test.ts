import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { logger } from "@/lib/logger";
import { SQLiteStorageProvider } from "@/lib/storage/providers/sqlite";
import {
  LastAdminError,
  PasskeyRegistrationConflict,
  type PasskeyRegistrationWrite,
  type StoredAccount,
  type StoredPasskey,
} from "@/lib/storage/types";
import { type ContractStore, PASSKEY_STORE_CONTRACT } from "../../../../helpers/passkey-store-contract";

// A real database file per case, like sqlite-accounts.test.ts: transactions, foreign keys and
// conflict clauses are properties of the engine that a mocked driver cannot show.

async function openSqliteStore(): Promise<ContractStore> {
  const dir = mkdtempSync(join(tmpdir(), "libredb-sqlite-passkeys-"));
  const file = join(dir, "store.db");
  const provider = new SQLiteStorageProvider(file);
  await provider.initialize();
  return {
    provider,
    async close() {
      await provider.close();
      rmSync(dir, { recursive: true, force: true });
    },
    // A second connection with foreign keys off, as the sqlite3 shell opens one by default.
    async orphanAccount(email) {
      const side = new Database(file);
      try {
        side.pragma("foreign_keys = OFF");
        side.prepare("DELETE FROM accounts WHERE email = ?").run(email);
      } finally {
        side.close();
      }
    },
  };
}

describe("SQLite passkey store contract", () => {
  for (const c of PASSKEY_STORE_CONTRACT) test(c.name, () => c.run(openSqliteStore));
});

const account: StoredAccount = {
  email: "ada@example.com",
  passwordHash: "scrypt$hash",
  role: "user",
  totpSecret: null,
  totpPending: null,
  disabled: false,
  sessionVersion: 0,
  createdAt: "2026-09-28T00:00:00.000Z",
  updatedAt: "2026-09-28T00:00:00.000Z",
};

function registration(email = account.email, handle = "handle-ada"): PasskeyRegistrationWrite {
  const passkey: StoredPasskey = {
    id: randomUUID(),
    credentialId: randomUUID(),
    accountEmail: email,
    publicKey: "pub",
    signCount: 0,
    transports: ["usb"],
    backupEligible: false,
    backupState: false,
    rpId: "studio.example.com",
    name: "Key",
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  };
  return {
    passkey,
    userHandle: handle,
    expectedSessionVersion: 0,
    maxPasskeys: 20,
    challenge: { hash: randomUUID(), expiresAt: new Date(Date.now() + 600_000).toISOString() },
    purgeSpentBefore: new Date(Date.now() - 600_000).toISOString(),
  };
}

describe("SQLiteStorageProvider passkeys", () => {
  let dir = "";
  let path = "";
  let provider: SQLiteStorageProvider;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "libredb-sqlite-passkeys-"));
    path = join(dir, "store.db");
    provider = new SQLiteStorageProvider(path);
    await provider.initialize();
    await provider.insertAccount(account);
  });

  afterEach(async () => {
    await provider.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // Foreign keys are now on for the whole connection, and user_storage has none of its own: its
  // writes and the account delete that removes its rows must behave as they did before.
  test("user storage writes and the account delete still work with foreign keys on", async () => {
    await provider.setCollection(account.email, "connections", []);
    await provider.mergeData(account.email, { history: [], saved_queries: [] });
    expect(await provider.getCollection(account.email, "connections")).toEqual([]);
    expect(await provider.getCollection(account.email, "history")).toEqual([]);
    await provider.insertPasskey(registration());
    expect((await provider.listAccounts()).map((row) => row.email)).toEqual([account.email]);

    await provider.deleteAccount(account.email);

    expect(await provider.listAccounts()).toEqual([]);
    expect(await provider.getCollection(account.email, "connections")).toBeNull();
    expect(await provider.getCollection(account.email, "history")).toBeNull();
    expect(await provider.listPasskeys(account.email)).toEqual([]);
  });

  test("initialize creates the three passkey tables and turns foreign keys on", () => {
    const side = new Database(path);
    try {
      const rows = side.prepare("SELECT type, name, sql FROM sqlite_master").all() as {
        type: string;
        name: string;
        sql: string | null;
      }[];
      const byName = new Map(rows.map((row) => [row.name, row]));
      for (const table of ["passkey_users", "passkey_credentials", "passkey_spent_challenges"]) {
        expect(byName.get(table)?.type).toBe("table");
      }
      expect(byName.get("passkey_credentials_account")?.type).toBe("index");
      expect(byName.get("passkey_spent_challenges_expiry")?.type).toBe("index");
      expect(byName.get("passkey_users")?.sql).toMatch(/REFERENCES accounts\(email\) ON DELETE CASCADE/);
      expect(byName.get("passkey_credentials")?.sql).toMatch(
        /REFERENCES passkey_users\(account_email\) ON DELETE CASCADE/,
      );
    } finally {
      side.close();
    }
  });

  test("two providers on one file behave as two replicas: a challenge spent through one is refused through the other", async () => {
    const replica = new SQLiteStorageProvider(path);
    await replica.initialize();
    try {
      const first = registration();
      await provider.insertPasskey(first);
      const second = { ...registration(), challenge: first.challenge };
      await expect(replica.insertPasskey(second)).rejects.toMatchObject({ reason: "challenge_spent" });
      expect((await replica.listPasskeys(account.email)).map((p) => p.id)).toEqual([first.passkey.id]);
    } finally {
      await replica.close();
    }
  });

  test("updateAccount with clearPasskeys rolls back the passkey delete when the account write fails", async () => {
    await provider.insertPasskey(registration());
    const side = new Database(path);
    side.exec(
      "CREATE TRIGGER refuse_account_update BEFORE UPDATE ON accounts BEGIN SELECT RAISE(ABORT, 'refused'); END;",
    );
    side.close();

    await expect(
      provider.updateAccount(
        { ...account, sessionVersion: 1, updatedAt: "2026-09-29T00:00:00.000Z" },
        { expected: account, clearPasskeys: true },
      ),
    ).rejects.toThrow(/refused/);
    expect(await provider.listPasskeys(account.email)).toHaveLength(1);
  });

  test("updateAccount with clearPasskeys rolls back the passkey delete when a check after it fails", async () => {
    // The last-admin check runs after the delete, so only a real rollback brings the passkey back.
    const admin: StoredAccount = { ...account, email: "root@example.com", role: "admin" };
    await provider.insertAccount(admin);
    await provider.insertPasskey(registration(admin.email, "handle-root"));

    await expect(
      provider.updateAccount(
        { ...admin, role: "user", sessionVersion: 1, updatedAt: "2026-09-29T00:00:00.000Z" },
        { expected: admin, clearPasskeys: true, keepEnabledAdmin: true },
      ),
    ).rejects.toBeInstanceOf(LastAdminError);
    expect(await provider.listPasskeys(admin.email)).toHaveLength(1);
    expect(await provider.getAccount(admin.email)).toEqual(admin);
  });

  test("an account deleted without foreign keys leaves no passkey for the next account with that email", async () => {
    const old = registration();
    await provider.insertPasskey(old);
    const side = new Database(path);
    try {
      side.pragma("foreign_keys = OFF");
      side.prepare("DELETE FROM accounts WHERE email = ?").run(account.email);
      const orphans = side
        .prepare("SELECT COUNT(*) AS n FROM passkey_credentials WHERE account_email = ?")
        .get(account.email) as { n: number };
      expect(orphans.n).toBe(1);
    } finally {
      side.close();
    }

    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await provider.insertAccount(account);
      const calls = warn.mock.calls.filter((call) => String(call[0]).includes("under a reused email"));
      expect(calls).toHaveLength(1);
      expect(calls[0][1]).toEqual({ provider: "sqlite", removed: 2 });
      expect(JSON.stringify(calls[0])).not.toContain(account.email);
    } finally {
      warn.mockRestore();
    }

    expect(await provider.listPasskeys(account.email)).toEqual([]);
    expect(await provider.getPasskeyUserHandle(account.email)).toBeNull();
    expect(await provider.findPasskey(old.passkey.credentialId)).toBeNull();
    await provider.insertPasskey(registration(account.email, "handle-ada-again"));
    expect(await provider.getPasskeyUserHandle(account.email)).toBe("handle-ada-again");
  });

  test("an insert that fails because the account exists removes nothing", async () => {
    await provider.insertPasskey(registration());
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await expect(provider.insertAccount(account)).rejects.toThrow(/UNIQUE/);
      expect(warn.mock.calls.filter((call) => String(call[0]).includes("under a reused email"))).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
    expect(await provider.listPasskeys(account.email)).toHaveLength(1);
    expect(await provider.getPasskeyUserHandle(account.email)).toBe("handle-ada");
  });

  test("a conflict is a PasskeyRegistrationConflict carrying its reason in the message", async () => {
    const error = await provider.insertPasskey(registration("nobody@example.com")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PasskeyRegistrationConflict);
    expect((error as Error).message).toBe("passkey registration refused: account_missing");
  });
});
