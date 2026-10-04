import { describe, expect, test } from "bun:test";
import { connectionIdentity } from "@/lib/agent/context-snapshot";
import { connectionFingerprint } from "@/lib/db/connection-fingerprint";
import { providerCacheKey } from "@/lib/db/provider-cache-key";
import type { DatabaseConnection } from "@/lib/types";

/**
 * The read-only mode in the provider cache key, and in nothing else (#1089).
 *
 * A provider opened read-only refuses every write, so the cache may not hand a read-only caller a
 * pool opened read-write, nor the reverse: the mode is the key's fourth length-framed part. It is part
 * of no identity digest, because the fingerprint says which server a plan is sealed to and the run
 * identity which database a reading came from, and the mode changes neither: the fingerprint's
 * digests are pinned byte for byte in connection-fingerprint.test.ts, and a run's stored identity is
 * compared on every follow-up.
 */
const base: DatabaseConnection = {
  id: "cluster",
  name: "Cluster",
  type: "postgres",
  host: "db.internal",
  port: 5432,
  database: "app",
  user: "app",
  password: "app-password",
  createdAt: new Date(0),
};

describe("providerCacheKey frames the read-only mode (#1089)", () => {
  test("false and an absent readOnly are one mode, so they answer one key", async () => {
    expect(await providerCacheKey({ ...base, readOnly: false })).toBe(await providerCacheKey(base));
  });

  test("readOnly: true answers a key neither of the other two shares", async () => {
    const readOnly = await providerCacheKey({ ...base, readOnly: true });

    expect(readOnly).not.toBe(await providerCacheKey(base));
    expect(readOnly).not.toBe(await providerCacheKey({ ...base, readOnly: false }));
  });

  test("the mode is the fourth length-framed part, after the id, the server and the credentials", async () => {
    expect((await providerCacheKey({ ...base, readOnly: true })).endsWith("9:read-only")).toBe(true);
    expect((await providerCacheKey(base)).endsWith("10:read-write")).toBe(true);
  });
});

describe("the read-only mode is part of no identity digest (#1089)", () => {
  test("the server a plan is sealed to does not move with it", async () => {
    expect(await connectionFingerprint({ ...base, readOnly: true })).toBe(await connectionFingerprint(base));
  });

  test("the database a reading came from does not move with it", () => {
    expect(connectionIdentity({ ...base, readOnly: true })).toBe(connectionIdentity(base));
  });
});

describe("providerCacheKey frames Db2's consent to a cleartext password (#786)", () => {
  const db2: DatabaseConnection = { ...base, type: "db2", port: 50000, database: "TESTDB" };

  test("a connection whose consent was taken back is not handed the provider opened under it", async () => {
    const consented = await providerCacheKey({ ...db2, allowInsecureAuth: true });

    expect(consented).not.toBe(await providerCacheKey(db2));
    expect(await providerCacheKey({ ...db2, allowInsecureAuth: false })).toBe(await providerCacheKey(db2));
  });
});

describe("providerCacheKey frames the data servers a token may be sent to", () => {
  test("a connection whose list changed is not handed a provider whose policy admitted other hosts", async () => {
    const listed = await providerCacheKey({ ...base, dataServers: "a.internal:6648" });
    expect(listed).not.toBe(await providerCacheKey(base));
    expect(listed).not.toBe(await providerCacheKey({ ...base, dataServers: "b.internal:6648" }));
    expect(await providerCacheKey({ ...base, dataServers: "" })).toBe(await providerCacheKey(base));
  });
});
