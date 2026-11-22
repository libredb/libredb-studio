import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { SQLiteStorageProvider } from "@/lib/storage/providers/sqlite";
import type { StoredAccount, StoredCredentialRewrite } from "@/lib/storage/types";

// A real database file, as sqlite-accounts.test.ts uses: a backup, a lock and a rollback are properties of the
// engine, and a mocked transaction() would pass whether or not they happened.

const LABEL = "pre-reseal-20261122T053000Z";

function account(email: string, totpSecret: string | null): StoredAccount {
  return {
    email,
    passwordHash: "scrypt$hash",
    role: "user",
    totpSecret,
    totpPending: null,
    disabled: false,
    sessionVersion: 3,
    createdAt: "t",
    updatedAt: "u",
  };
}

describe("SQLiteStorageProvider credential envelope", () => {
  let dir = "";
  let path = "";
  let provider: SQLiteStorageProvider;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "libredb-sqlite-envelope-"));
    path = join(dir, "store.db");
    provider = new SQLiteStorageProvider(path);
    await provider.initialize();
  });

  afterEach(async () => {
    await provider.close();
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  });

  /** Raw SQL against the store, on a connection of its own, as an operator's tool would. */
  function raw<T>(run: (db: Database.Database) => T, file = path): T {
    const db = new Database(file);
    try {
      return run(db);
    } finally {
      db.close();
    }
  }

  test("initialize creates storage_meta with the other tables", () => {
    const tables = raw((db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all());
    expect(tables.map((row) => (row as { name: string }).name)).toContain("storage_meta");
  });

  test("readEnvelopeState answers v1-accepted without a row and v1-retired for v2, and refuses any other value by name", async () => {
    expect(await provider.readEnvelopeState()).toBe("v1-accepted");

    raw((db) => db.prepare("INSERT INTO storage_meta (key, value) VALUES ('credential_envelope', 'v2')").run());
    expect(await provider.readEnvelopeState()).toBe("v1-retired");

    raw((db) => db.prepare("UPDATE storage_meta SET value = 'v3' WHERE key = 'credential_envelope'").run());
    await expect(provider.readEnvelopeState()).rejects.toThrow('credential_envelope is "v3"');
  });

  test("rewriteStoredCredentials backs up with VACUUM INTO on a second connection inside the immediate transaction, then rewrites and marks v2", async () => {
    const before = randomUUID();
    const after = randomUUID();
    await provider.setCollection("alice", "connections", [{ id: "c1", password: before }] as never);
    await provider.setCollection("alice", "history", [{ id: "h1" }] as never);
    await provider.insertAccount(account("ada@example.com", before));
    const seen: string[] = [];
    const rewrite: StoredCredentialRewrite = {
      connections: (owner, data) => {
        seen.push(`${owner} ${data}`);
        // Inside the transaction, another writer cannot get in: the write lock is held.
        expect(() =>
          raw((db) => {
            db.pragma("busy_timeout = 0");
            db.prepare("INSERT INTO storage_meta (key, value) VALUES ('probe', 'x')").run();
          }),
        ).toThrow("database is locked");
        return data.replace(before, after);
      },
      factors: (row) => ({ totpSecret: `${row.totpSecret}-after`, totpPending: row.totpPending }),
    };

    const result = await provider.rewriteStoredCredentials(rewrite, LABEL);

    expect(result).toEqual({ kind: "rewritten", backup: `${path}.${LABEL}` });
    expect(seen).toEqual([`alice [{"id":"c1","password":"${before}"}]`]);
    expect(await provider.getCollection("alice", "connections")).toEqual([{ id: "c1", password: after }] as never);
    expect(await provider.getCollection("alice", "history")).toEqual([{ id: "h1" }] as never);
    const stored = await provider.getAccount("ada@example.com");
    expect(stored).toEqual({ ...account("ada@example.com", `${before}-after`) });
    expect(await provider.readEnvelopeState()).toBe("v1-retired");
    // The backup is the store as it was: the old rows, no marker.
    const backup = raw(
      (db) => ({
        data: db.prepare("SELECT data FROM user_storage WHERE collection = 'connections'").get(),
        factor: db.prepare("SELECT totp_secret FROM accounts").get(),
        marker: db.prepare("SELECT value FROM storage_meta").get(),
      }),
      `${path}.${LABEL}`,
    );
    expect(backup).toEqual({
      data: { data: `[{"id":"c1","password":"${before}"}]` },
      factor: { totp_secret: before },
      marker: undefined,
    });
  });

  test("a rewrite that throws part way leaves the store unchanged and v1 accepted, and keeps its backup file", async () => {
    await provider.setCollection("alice", "connections", [{ id: "c1" }] as never);
    await provider.setCollection("bob", "connections", [{ id: "c2" }] as never);
    const failure = new Error("rewrite failed on the second row");
    let calls = 0;
    const rewrite: StoredCredentialRewrite = {
      connections: (_owner, data) => {
        calls += 1;
        if (calls === 2) throw failure;
        return data.replace("c1", "changed");
      },
      factors: () => null,
    };

    await expect(provider.rewriteStoredCredentials(rewrite, LABEL)).rejects.toBe(failure);

    expect(await provider.getCollection("alice", "connections")).toEqual([{ id: "c1" }] as never);
    expect(await provider.readEnvelopeState()).toBe("v1-accepted");
    expect(existsSync(`${path}.${LABEL}`)).toBe(true);
  });

  test("a backup that cannot be written refuses the run and leaves the store unchanged", async () => {
    await provider.setCollection("alice", "connections", [{ id: "c1" }] as never);
    const rewrite: StoredCredentialRewrite = { connections: () => "[]", factors: () => null };
    raw((db) => db.prepare("VACUUM INTO ?").run(`${path}.${LABEL}`));

    await expect(provider.rewriteStoredCredentials(rewrite, LABEL)).rejects.toThrow("EEXIST");

    expect(await provider.getCollection("alice", "connections")).toEqual([{ id: "c1" }] as never);
    expect(await provider.readEnvelopeState()).toBe("v1-accepted");
  });

  test.skipIf(process.platform === "win32")(
    "the backup file takes the store file's mode, whatever the process umask allows (POSIX only: NTFS has no mode bits)",
    async () => {
      await provider.setCollection("alice", "connections", [{ id: "c1", password: randomUUID() }] as never);
      chmodSync(path, 0o600);
      const rewrite: StoredCredentialRewrite = { connections: () => null, factors: () => null };
      const umask = process.umask(0o022);
      try {
        await provider.rewriteStoredCredentials(rewrite, LABEL);
      } finally {
        process.umask(umask);
      }

      expect(statSync(`${path}.${LABEL}`).mode & 0o777).toBe(0o600);
      expect(raw((db) => db.prepare("SELECT data FROM user_storage").all(), `${path}.${LABEL}`)).toHaveLength(1);
    },
  );

  test("rewriteStoredCredentials refuses an in-memory store", async () => {
    const memory = new SQLiteStorageProvider(":memory:");
    await memory.initialize();
    try {
      await expect(
        memory.rewriteStoredCredentials({ connections: () => null, factors: () => null }, LABEL),
      ).rejects.toThrow("in-memory");
      expect(await memory.readEnvelopeState()).toBe("v1-accepted");
    } finally {
      await memory.close();
    }
  });

  test("a retired store is neither read nor backed up", async () => {
    await provider.setCollection("alice", "connections", [{ id: "c1" }] as never);
    raw((db) => db.prepare("INSERT INTO storage_meta (key, value) VALUES ('credential_envelope', 'v2')").run());
    const rewrite: StoredCredentialRewrite = {
      connections: () => {
        throw new Error("read a retired store");
      },
      factors: () => {
        throw new Error("read a retired store");
      },
    };

    expect(await provider.rewriteStoredCredentials(rewrite, LABEL)).toEqual({ kind: "already-retired" });
    expect(existsSync(`${path}.${LABEL}`)).toBe(false);
  });
});
