/**
 * `resealStore`, the operator re-seal (docs/STORAGE.md, "Re-sealing the store"), over the in-memory store that keeps
 * rows as a real provider does. The provider's own transaction and backup are tested with each provider.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { decryptConnections } from "@/lib/storage/connection-secrets";
import {
  openSecret,
  resetStorageEncryptionKey,
  sealSecret,
  STORAGE_ENCRYPTION_KEY_MISSING_MESSAGE,
} from "@/lib/storage/encryption";
import { accountBinding, connectionBinding } from "@/lib/storage/envelope-binding";
import { resealBackupLabel, resealStore } from "@/lib/storage/reseal";
import type { StoredAccount } from "@/lib/storage/types";
import type { DatabaseConnection } from "@/lib/types";
import { MemoryStorageProvider } from "../../../helpers/memory-storage-provider";
import { sealVersionOne } from "../../../helpers/storage-envelope-v1";

const NOW = new Date("2026-11-22T05:30:00.123Z");
const snapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  snapshot.JWT_SECRET = process.env.JWT_SECRET;
  snapshot.STORAGE_ENCRYPTION_KEY = process.env.STORAGE_ENCRYPTION_KEY;
  process.env.JWT_SECRET = randomBytes(32).toString("base64url");
  delete process.env.STORAGE_ENCRYPTION_KEY;
  resetStorageEncryptionKey();
});

afterEach(() => {
  for (const key of ["JWT_SECRET", "STORAGE_ENCRYPTION_KEY"] as const) {
    if (snapshot[key] === undefined) delete process.env[key];
    else process.env[key] = snapshot[key];
  }
  resetStorageEncryptionKey();
});

function connection(id: string, overrides: Record<string, unknown> = {}): DatabaseConnection {
  return {
    id,
    name: id,
    type: "postgres",
    host: `${id}.internal`,
    user: "app",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as unknown as DatabaseConnection;
}

function account(email: string, totpSecret: string | null, totpPending: string | null = null): StoredAccount {
  return {
    email,
    passwordHash: "scrypt$hash",
    role: "user",
    totpSecret,
    totpPending,
    disabled: false,
    sessionVersion: 1,
    createdAt: "t",
    updatedAt: "t",
  };
}

const rowOf = (store: MemoryStorageProvider, owner: string): DatabaseConnection[] =>
  JSON.parse(store.row(owner, "connections") ?? "null");

describe("resealStore", () => {
  test("re-seals every v1 and unsealed connection value of every row as v2 bound to its place", async () => {
    const store = new MemoryStorageProvider();
    const [first, second, third] = [randomUUID(), randomUUID(), randomUUID()];
    store.putRow("alice", "connections", JSON.stringify([connection("c1", { password: sealVersionOne(first) })]));
    store.putRow(
      "bob",
      "connections",
      JSON.stringify([connection("c2", { password: second, sshTunnel: { enabled: true, password: third } })]),
    );

    const report = await resealStore(store, NOW);

    expect(report).toMatchObject({ kind: "rewritten", resealed: 3, kept: 0, unopened: [], unread: [] });
    expect(store.marker).toBe("v2");
    expect(rowOf(store, "alice")[0].password).toStartWith("v2:");
    expect(rowOf(store, "bob")[0].sshTunnel?.password).toStartWith("v2:");
    expect(decryptConnections("alice", rowOf(store, "alice"), "v1-retired").connections[0].password).toBe(first);
    const bob = decryptConnections("bob", rowOf(store, "bob"), "v1-retired");
    expect([bob.connections[0].password, bob.connections[0].sshTunnel?.password]).toEqual([second, third]);
    expect(bob.omitted).toEqual([]);
  });

  test("re-seals every v1 and unsealed factor", async () => {
    const store = new MemoryStorageProvider();
    const [secret, pending] = [randomUUID(), randomUUID()];
    store.accounts.set("ada@example.com", account("ada@example.com", sealVersionOne(secret), pending));
    store.accounts.set("bob@example.com", account("bob@example.com", null));

    const report = await resealStore(store, NOW);

    expect(report).toMatchObject({ kind: "rewritten", resealed: 2, kept: 0 });
    const ada = store.accounts.get("ada@example.com")!;
    expect(openSecret(ada.totpSecret!, accountBinding("ada@example.com").field("totpSecret"))).toEqual({
      kind: "v2",
      value: secret,
    });
    expect(openSecret(ada.totpPending!, accountBinding("ada@example.com").field("totpPending"))).toEqual({
      kind: "v2",
      value: pending,
    });
    expect(store.accounts.get("bob@example.com")).toEqual(account("bob@example.com", null));
  });

  test("keeps a v2 value that opens and leaves and names a value that does not", async () => {
    const store = new MemoryStorageProvider();
    const record = connection("c1", { agentUser: "ro" });
    const bound = sealSecret(randomUUID(), connectionBinding("alice", record).field("password"));
    const elsewhere = sealSecret(randomUUID(), connectionBinding("bob", record).field("agentPassword"));
    store.putRow("alice", "connections", JSON.stringify([{ ...record, password: bound, agentPassword: elsewhere }]));
    const factor = sealSecret(randomUUID(), accountBinding("ada@example.com").field("totpSecret"));
    const broken = `v1:${randomUUID()}`;
    store.accounts.set("ada@example.com", account("ada@example.com", factor, broken));

    const report = await resealStore(store, NOW);

    expect(report).toMatchObject({
      kind: "rewritten",
      resealed: 0,
      kept: 2,
      unopened: ["alice c1 agentPassword", "ada@example.com totpPending"],
    });
    expect(rowOf(store, "alice")[0]).toMatchObject({ password: bound, agentPassword: elsewhere });
    expect(store.accounts.get("ada@example.com")).toMatchObject({ totpSecret: factor, totpPending: broken });
  });

  test("leaves and names a row whose connections are not a JSON list", async () => {
    const store = new MemoryStorageProvider();
    const plain = randomUUID();
    store.putRow("alice", "connections", "{not json");
    store.putRow("bob", "connections", JSON.stringify({ id: "c1" }));
    store.putRow("carol", "connections", JSON.stringify([7, null, connection("c3", { password: plain })]));

    const report = await resealStore(store, NOW);

    expect(report).toMatchObject({
      kind: "rewritten",
      resealed: 1,
      unread: ["alice connections", "bob connections", "carol connections[0]", "carol connections[1]"],
    });
    expect(store.row("alice", "connections")).toBe("{not json");
    expect(store.row("bob", "connections")).toBe(JSON.stringify({ id: "c1" }));
    const carol = rowOf(store, "carol");
    expect(carol.slice(0, 2)).toEqual([7, null] as never);
    expect(decryptConnections("carol", [carol[2]], "v1-retired").connections[0].password).toBe(plain);
  });

  test("a row with nothing to re-seal is not written", async () => {
    const store = new MemoryStorageProvider();
    const text = JSON.stringify([connection("c1")]);
    store.putRow("alice", "connections", ` ${text}`);

    await resealStore(store, NOW);

    expect(store.row("alice", "connections")).toBe(` ${text}`);
  });

  test("reports where the backup was written", async () => {
    const store = new MemoryStorageProvider();

    const report = await resealStore(store, NOW);

    expect(report).toEqual({
      kind: "rewritten",
      backup: "memory:pre-reseal-20261122T053000Z",
      resealed: 0,
      kept: 0,
      unopened: [],
      refused: [],
      unread: [],
    });
    expect(store.backups.map(({ label }) => label)).toEqual(["pre-reseal-20261122T053000Z"]);
  });

  test("a store that retired v1 already is left untouched with no backup", async () => {
    const store = new MemoryStorageProvider();
    store.marker = "v2";
    store.putRow("alice", "connections", JSON.stringify([connection("c1", { password: randomUUID() })]));
    const before = store.row("alice", "connections");

    expect(await resealStore(store, NOW)).toEqual({ kind: "already-retired" });
    expect(store.row("alice", "connections")).toBe(before);
    expect(store.backups).toEqual([]);
  });

  test("a store re-sealed without usable key material is refused by name before anything is read, written or backed up", async () => {
    const store = new MemoryStorageProvider();
    // Only version 1 values, which a missing key could otherwise take for unopenable and retire unopened.
    store.putRow(
      "alice",
      "connections",
      JSON.stringify([connection("c1", { password: sealVersionOne(randomUUID()) })]),
    );
    store.accounts.set("ada@example.com", account("ada@example.com", sealVersionOne(randomUUID())));
    const before = store.row("alice", "connections");
    const nodeEnv = process.env.NODE_ENV;
    delete process.env.JWT_SECRET;
    (process.env as Record<string, string>).NODE_ENV = "production";
    resetStorageEncryptionKey();
    try {
      await expect(resealStore(store, NOW)).rejects.toThrow(STORAGE_ENCRYPTION_KEY_MISSING_MESSAGE);
    } finally {
      if (nodeEnv === undefined) delete (process.env as Record<string, string | undefined>).NODE_ENV;
      else (process.env as Record<string, string>).NODE_ENV = nodeEnv;
    }

    expect(store.row("alice", "connections")).toBe(before);
    expect(store.marker).toBeUndefined();
    expect(store.backups).toEqual([]);
  });

  test("leaves and names a value that is not text or sits beside a v2 value, and a connection that has no binding", async () => {
    const store = new MemoryStorageProvider();
    const record = connection("c1");
    const password = sealSecret(randomUUID(), connectionBinding("alice", record).field("password"));
    const unsealedValue = randomUUID();
    let deep: unknown = "x";
    for (let level = 0; level < 3000; level++) deep = [deep];
    const plain = randomUUID();
    const row = JSON.stringify([
      { ...record, password, connectionString: unsealedValue, apiKeyId: 7 },
      connection("c2", { host: deep, password: randomUUID() }),
      connection("c3", { password: plain }),
    ]);
    store.putRow("alice", "connections", row);

    const report = await resealStore(store, NOW);

    expect(report).toMatchObject({
      kind: "rewritten",
      resealed: 1,
      kept: 1,
      refused: ["alice c1 apiKeyId (not-text)", "alice c1 connectionString (mixed)"],
      unread: ["alice connections[1]"],
    });
    const [first, second, third] = rowOf(store, "alice");
    expect(first).toEqual(JSON.parse(row)[0]);
    expect(second).toEqual(JSON.parse(row)[1]);
    expect(decryptConnections("alice", [third], "v1-retired").connections[0].password).toBe(plain);
  });

  test("a re-seal under the wrong key retires version 1 over values it left, and the documented recovery reopens them", async () => {
    // docs/STORAGE.md, "Re-sealing the store": restore the key that sealed the store, delete the credential_envelope
    // row with every server stopped, and re-seal again.
    const store = new MemoryStorageProvider();
    const secret = randomUUID();
    const sealingKey = process.env.JWT_SECRET;
    store.putRow("alice", "connections", JSON.stringify([connection("c1", { password: sealVersionOne(secret) })]));
    process.env.JWT_SECRET = randomBytes(32).toString("base64url");
    resetStorageEncryptionKey();

    expect(await resealStore(store, NOW)).toMatchObject({ resealed: 0, unopened: ["alice c1 password"] });
    expect(store.marker).toBe("v2");

    process.env.JWT_SECRET = sealingKey;
    resetStorageEncryptionKey();
    const [stillStored] = rowOf(store, "alice");
    // The key alone does not bring it back: version 1 is retired, and a second re-seal finds nothing to do.
    expect(decryptConnections("alice", [stillStored], "v1-retired").omitted).toEqual([
      { id: "c1", path: "password", reason: "retired" },
    ]);
    expect(await resealStore(store, NOW)).toEqual({ kind: "already-retired" });

    store.marker = undefined;
    expect(await resealStore(store, new Date("2026-11-22T06:00:00Z"))).toMatchObject({ resealed: 1, unopened: [] });
    const [after] = rowOf(store, "alice");
    expect(decryptConnections("alice", [after], "v1-retired").connections[0].password).toBe(secret);
  });

  test("the backup label is pre-reseal- and the UTC time to the second", () => {
    expect(resealBackupLabel(NOW)).toBe("pre-reseal-20261122T053000Z");
    expect(resealBackupLabel(new Date("2027-01-02T03:04:05.999+02:00"))).toBe("pre-reseal-20270102T010405Z");
  });
});
