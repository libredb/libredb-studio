/**
 * The operator re-seal against a real STORAGE_PROVIDER=sqlite file (docs/STORAGE.md, "Re-sealing the store"): a store
 * the previous version wrote is backed up completely, every stored credential is sealed as a version 2 envelope for its
 * place, and version 1 is retired, in one transaction that leaves the store as it was on any failure.
 *
 * In-process under bun with better-sqlite3, as tests/api/auth/totp-reauth.test.ts already runs a real store file.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { logger } from "@/lib/logger";
import { UNDECRYPTABLE_WARNING_PREFIX, withCredentialEncryption } from "@/lib/storage/encrypting-provider";
import { resetStorageEncryptionKey, STORAGE_ENCRYPTION_KEY_MISSING_MESSAGE } from "@/lib/storage/encryption";
import { SQLiteStorageProvider } from "@/lib/storage/providers/sqlite";
import { ResealRefused, resealBackupLabel, resealStore } from "@/lib/storage/reseal";
import type { ServerStorageProvider } from "@/lib/storage/types";
import { sealVersionOne } from "../../helpers/storage-envelope-v1";

const NOW = new Date("2026-11-22T05:30:00.000Z");
// The envelope settings are cleared too: each test decides the store's state, and a checkout's .env, which bun loads
// in test runs, may set either.
const SAVED = [
  "JWT_SECRET",
  "STORAGE_ENCRYPTION_KEY",
  "NODE_ENV",
  "STORAGE_ENCRYPTION_REQUIRE_V2",
  "STORAGE_ENCRYPTION_RESEAL",
] as const;

describe("re-sealing a real SQLite store", () => {
  const saved: Record<string, string | undefined> = {};
  let dir = "";
  let path = "";
  let secrets: { alice: string; bob: string; factor: string; tunnel: string };
  const open: ServerStorageProvider[] = [];

  beforeEach(() => {
    for (const key of SAVED) saved[key] = process.env[key];
    process.env.JWT_SECRET = randomBytes(32).toString("base64url");
    delete process.env.STORAGE_ENCRYPTION_KEY;
    delete process.env.STORAGE_ENCRYPTION_REQUIRE_V2;
    delete process.env.STORAGE_ENCRYPTION_RESEAL;
    resetStorageEncryptionKey();
    dir = mkdtempSync(join(tmpdir(), "libredb-sqlite-reseal-"));
    path = join(dir, "store.db");
    secrets = { alice: randomUUID(), bob: randomUUID(), factor: randomUUID(), tunnel: randomUUID() };
  });

  afterEach(async () => {
    await Promise.all(open.splice(0).map((provider) => provider.close()));
    for (const key of SAVED) {
      if (saved[key] === undefined) delete (process.env as Record<string, string | undefined>)[key];
      else (process.env as Record<string, string>)[key] = saved[key];
    }
    resetStorageEncryptionKey();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Raw SQL against a store file, on a connection of its own. */
  function raw<T>(run: (db: Database.Database) => T, file = path): T {
    const db = new Database(file);
    try {
      return run(db);
    } finally {
      db.close();
    }
  }

  /**
   * The rows the previous version wrote: a v1 password, an unsealed tunnel password, a v1 factor. The store's first
   * table exists before this version's initialize, as on a store the previous version created, so it records nothing
   * about version 1.
   */
  async function previousVersionStore(): Promise<void> {
    raw((db) =>
      db.exec(
        "CREATE TABLE user_storage (user_id TEXT NOT NULL, collection TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (user_id, collection))",
      ),
    );
    const store = new SQLiteStorageProvider(path);
    await store.initialize();
    await store.setCollection("alice", "connections", [
      { id: "c1", name: "c1", type: "postgres", host: "a.internal", password: sealVersionOne(secrets.alice) },
    ] as never);
    await store.setCollection("bob", "connections", [
      {
        id: "c2",
        name: "c2",
        type: "postgres",
        host: "b.internal",
        password: sealVersionOne(secrets.bob),
        sshTunnel: { enabled: true, host: "bastion", password: secrets.tunnel },
      },
    ] as never);
    await store.setCollection("bob", "history", [{ id: "h1" }] as never);
    await store.insertAccount({
      email: "ada@example.com",
      passwordHash: "scrypt$hash",
      role: "user",
      totpSecret: sealVersionOne(secrets.factor),
      totpPending: null,
      disabled: false,
      sessionVersion: 1,
      createdAt: "t",
      updatedAt: "t",
    });
    await store.close();
  }

  async function provider(): Promise<ServerStorageProvider> {
    const wrapped = withCredentialEncryption(new SQLiteStorageProvider(path));
    open.push(wrapped);
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await wrapped.initialize();
    } finally {
      warn.mockRestore();
    }
    return wrapped;
  }

  const dump = (file = path) =>
    raw(
      (db) => ({
        rows: db.prepare("SELECT user_id, collection, data FROM user_storage ORDER BY user_id, collection").all(),
        accounts: db.prepare("SELECT email, totp_secret, totp_pending, updated_at FROM accounts").all(),
        marker: db.prepare("SELECT value FROM storage_meta").all(),
      }),
      file,
    );

  test("re-seals a store the previous version wrote and retires v1, after a complete backup", async () => {
    await previousVersionStore();
    const store = await provider();

    const report = await resealStore(store, NOW);

    expect(report).toMatchObject({ kind: "rewritten", resealed: 4, kept: 0, unopened: [], unread: [] });
    expect(report.kind === "rewritten" && report.backup).toBe(`${path}.pre-reseal-20261122T053000Z`);
    const after = dump();
    expect(JSON.stringify(after.rows)).not.toContain('"v1:');
    expect(JSON.stringify(after.rows)).not.toContain(secrets.tunnel);
    expect(after.marker).toEqual([{ value: "v2" }]);
    expect((after.accounts as { totp_secret: string }[])[0].totp_secret).toStartWith("v2:");
    // A fresh process reads the retired store and opens every value.
    await store.close();
    const reader = await provider();
    const alice = (await reader.getCollection("alice", "connections")) ?? [];
    const bob = (await reader.getCollection("bob", "connections")) ?? [];
    expect(alice[0].password).toBe(secrets.alice);
    expect([bob[0].password, bob[0].sshTunnel?.password]).toEqual([secrets.bob, secrets.tunnel]);
    expect((await reader.getAccount("ada@example.com"))?.totpSecret).toBe(secrets.factor);
  });

  test("the backup holds every row as it was", async () => {
    await previousVersionStore();
    const before = dump();
    const store = await provider();

    await resealStore(store, NOW);

    expect(dump(`${path}.${resealBackupLabel(NOW)}`)).toEqual(before);
  });

  test("a v1 value written after the re-seal is refused by name", async () => {
    await previousVersionStore();
    const store = await provider();
    await resealStore(store, NOW);
    const late = sealVersionOne(randomUUID());
    raw((db) =>
      db
        .prepare("UPDATE user_storage SET data = ? WHERE user_id = 'alice' AND collection = 'connections'")
        .run(JSON.stringify([{ id: "c1", name: "c1", type: "postgres", host: "a.internal", password: late }])),
    );
    await store.close();
    const reader = await provider();

    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const read = (await reader.getCollection("alice", "connections")) ?? [];
      expect("password" in read[0]).toBe(false);
      const lines = warn.mock.calls.map((call) => String(call[0]));
      expect(lines.filter((line) => line.startsWith(UNDECRYPTABLE_WARNING_PREFIX))).toEqual([
        expect.stringContaining("c1 password (retired)"),
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  test("a second run writes no backup and changes nothing", async () => {
    await previousVersionStore();
    const store = await provider();
    await resealStore(store, NOW);
    const after = dump();

    expect(await resealStore(store, new Date("2026-11-22T06:00:00.000Z"))).toEqual({ kind: "already-retired" });
    expect(dump()).toEqual(after);
    expect(readdirSync(dir).filter((name) => name.includes("pre-reseal"))).toEqual([
      "store.db.pre-reseal-20261122T053000Z",
    ]);
  });

  test("a backup that cannot be written refuses the run and leaves the store unchanged", async () => {
    await previousVersionStore();
    const before = dump();
    const target = `${path}.${resealBackupLabel(NOW)}`;
    // A copy an earlier run left, and a file that is not a database at all: the run overwrites neither.
    raw((db) => db.prepare("VACUUM INTO ?").run(target));
    const store = await provider();

    await expect(resealStore(store, NOW)).rejects.toThrow("EEXIST");
    expect(dump()).toEqual(before);

    rmSync(target);
    writeFileSync(target, "an operator's notes");
    await expect(resealStore(store, NOW)).rejects.toThrow("EEXIST");
    expect(dump()).toEqual(before);
  });

  test("a run without usable key material is refused by name before the backup, and leaves the store unchanged", async () => {
    await previousVersionStore();
    // Only version 1 values: a missing key must not read them as unopenable and retire them unopened.
    raw((db) =>
      db
        .prepare("UPDATE user_storage SET data = ? WHERE user_id = 'bob' AND collection = 'connections'")
        .run(
          JSON.stringify([
            { id: "c2", name: "c2", type: "postgres", host: "b.internal", password: sealVersionOne(secrets.bob) },
          ]),
        ),
    );
    const before = dump();
    const store = await provider();
    delete process.env.JWT_SECRET;
    (process.env as Record<string, string>).NODE_ENV = "production";
    resetStorageEncryptionKey();

    await expect(resealStore(store, NOW)).rejects.toThrow(STORAGE_ENCRYPTION_KEY_MISSING_MESSAGE);

    expect(dump()).toEqual(before);
    expect(existsSync(`${path}.${resealBackupLabel(NOW)}`)).toBe(false);
  });

  test("a version 1 value the key in use does not open refuses the run by name and leaves the store as it was", async () => {
    await previousVersionStore();
    const before = dump();
    const store = await provider();
    process.env.JWT_SECRET = randomBytes(32).toString("base64url");
    resetStorageEncryptionKey();

    let refusal: unknown;
    try {
      await resealStore(store, NOW);
    } catch (error) {
      refusal = error;
    }

    expect(refusal).toBeInstanceOf(ResealRefused);
    expect((refusal as Error).message).toContain(
      "3 version 1 value(s) do not open under the key in use: alice c1 password, bob c2 password, ada@example.com totpSecret",
    );
    expect(dump()).toEqual(before);
    // Refused before the backup, so a start refused again and again leaves no copy of the store each time.
    expect(readdirSync(dir).filter((name) => name.includes("pre-reseal"))).toEqual([]);
  });

  test("with leave-unopened, version 1 values the key in use does not open are left, named and retired", async () => {
    await previousVersionStore();
    const store = await provider();
    process.env.JWT_SECRET = randomBytes(32).toString("base64url");
    resetStorageEncryptionKey();

    const report = await resealStore(store, NOW, { leaveUnopened: true });

    expect(report).toMatchObject({
      kind: "rewritten",
      resealed: 1,
      unopened: [],
      unopenedVersionOne: ["alice c1 password", "bob c2 password", "ada@example.com totpSecret"],
    });
    expect(dump().marker).toEqual([{ value: "v2" }]);
  });

  test("a row it must write back beside an element too deep to serialize fails the run by name and leaves the store as it was", async () => {
    await previousVersionStore();
    const depth = 200_000;
    const deep = `{"id":"c0","name":"c0","type":"postgres","host":${"[".repeat(depth)}"a.internal"${"]".repeat(depth)}}`;
    raw((db) => {
      const row = db
        .prepare("SELECT data FROM user_storage WHERE user_id = 'alice' AND collection = 'connections'")
        .get() as { data: string };
      db.prepare("UPDATE user_storage SET data = ? WHERE user_id = 'alice' AND collection = 'connections'").run(
        `[${deep},${row.data.slice(1)}`,
      );
    });
    const before = dump();
    const store = await provider();

    await expect(resealStore(store, NOW)).rejects.toThrow(
      "The re-seal cannot write the connections row of alice back: it cannot re-seal or serialize connections[0]",
    );
    expect(dump()).toEqual(before);
  });

  test("an element nested too deep in a field outside the binding fails the run by name, and leaves the store as it was and no backup", async () => {
    await previousVersionStore();
    const depth = 200_000;
    // No secret at all, beside bob's version 1 row: the element still cannot be bound in this runtime.
    const deep = `{"id":"c0","name":"c0","type":"postgres","host":"a.internal","options":${"[".repeat(depth)}"x"${"]".repeat(depth)}}`;
    raw((db) =>
      db
        .prepare("UPDATE user_storage SET data = ? WHERE user_id = 'alice' AND collection = 'connections'")
        .run(`[${deep}]`),
    );
    const before = dump();
    const store = await provider();

    await expect(resealStore(store, NOW)).rejects.toThrow(
      "The re-seal cannot write the connections row of alice back: it cannot re-seal or serialize connections[0]",
    );
    expect(dump()).toEqual(before);
    expect(readdirSync(dir).filter((name) => name.includes("pre-reseal"))).toEqual([]);
  });

  test("a value that does not open is left as it is and named", async () => {
    await previousVersionStore();
    const foreign = `v2:${randomBytes(12).toString("base64url")}:${randomBytes(32).toString("base64url")}`;
    raw((db) =>
      db
        .prepare("UPDATE user_storage SET data = ? WHERE user_id = 'alice' AND collection = 'connections'")
        .run(JSON.stringify([{ id: "c1", name: "c1", type: "postgres", host: "a.internal", password: foreign }])),
    );
    const store = await provider();

    const report = await resealStore(store, NOW);

    expect(report).toMatchObject({ kind: "rewritten", unopened: ["alice c1 password"] });
    const alice = raw(
      (db) =>
        db.prepare("SELECT data FROM user_storage WHERE user_id = 'alice' AND collection = 'connections'").get() as {
          data: string;
        },
    );
    expect(JSON.parse(alice.data)[0].password).toBe(foreign);
  });
});
