import { describe, expect, test } from "bun:test";
import { connectionIdentity } from "@/lib/agent/context-snapshot";
import { connectionFingerprint } from "@/lib/db/connection-fingerprint";
import { providerCacheKey } from "@/lib/db/provider-cache-key";
import {
  CONNECTION_FIELDS,
  type FieldClass,
  SECRET_FIELD_MAPS,
  SSH_TUNNEL_FIELDS,
  SSL_FIELDS,
} from "@/lib/storage/connection-secrets";
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

describe("providerCacheKey frames the DuckDB file-access posture, and only DuckDB's (B1/K1)", () => {
  const duck: DatabaseConnection = {
    id: "warehouse",
    name: "Warehouse",
    type: "duckdb",
    database: "/srv/data/warehouse.duckdb",
    createdAt: new Date(0),
  };

  test("a non-admin (deny) DuckDB handle keys apart from an admin (allow) one, so they never share a handle", async () => {
    const deny = await providerCacheKey(duck, false);
    const allow = await providerCacheKey(duck, true);

    expect(deny).not.toBe(allow);
  });

  test("only the deny posture adds bytes: allow and an absent posture are the key as it was before this field", async () => {
    const bare = await providerCacheKey(duck);
    expect(await providerCacheKey(duck, true)).toBe(bare);
    expect((await providerCacheKey(duck, false)).endsWith("23:duckdb-deny-file-access")).toBe(true);
  });

  test("the posture segment follows the mode, length-framed like every other part", async () => {
    expect((await providerCacheKey(duck, false)).endsWith("10:read-write23:duckdb-deny-file-access")).toBe(true);
  });

  test("a non-DuckDB connection's key is byte-identical whatever the posture, because only DuckDB reads it", async () => {
    const baseline = await providerCacheKey(base);
    expect(await providerCacheKey(base, true)).toBe(baseline);
    expect(await providerCacheKey(base, false)).toBe(baseline);
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

describe("providerCacheKey frames the Elasticsearch API key pair", () => {
  test("two connections differing only in either half, or in having a pair at all, answer different keys", async () => {
    const paired = await providerCacheKey({ ...base, apiKeyId: "key-one", apiKeySecret: "secret-one" });

    expect(paired).not.toBe(await providerCacheKey(base));
    expect(paired).not.toBe(await providerCacheKey({ ...base, apiKeyId: "key-two", apiKeySecret: "secret-one" }));
    expect(paired).not.toBe(await providerCacheKey({ ...base, apiKeyId: "key-one", apiKeySecret: "secret-two" }));
    expect(await providerCacheKey({ ...base, apiKeyId: "key-one", apiKeySecret: "secret-one" })).toBe(paired);
  });
});

const ssl: NonNullable<DatabaseConnection["ssl"]> = {
  mode: "verify-full",
  caCert: "ca",
  clientCert: "cert",
  clientKey: "key",
  rejectUnauthorized: true,
};
const tunnel: NonNullable<DatabaseConnection["sshTunnel"]> = {
  enabled: true,
  host: "bastion.internal",
  port: 22,
  username: "ops",
  authMethod: "password",
};

/**
 * Every field the connection store classifies as `secret` moves the key, so the next field classified
 * secret cannot be added without the cache key seeing it.
 *
 * `credentialDigest` is a hand-kept list, and the API key pair was once left out of it.
 * The maps in `src/lib/storage/connection-secrets.ts` fail typecheck when a field goes unclassified,
 * so walking them here turns a forgotten field into a red test. A field may be framed by
 * `credentialDigest` or by the fingerprint (`connectionString` is); the walk asks the whole key.
 * A public field that decides identity is outside this walk, so it is added to `credentialDigest` by
 * hand and gets a row in the table of the next block.
 */
describe("providerCacheKey frames every field the connection store classifies as secret", () => {
  /** Where a field of each map sits on a connection: at its root, in `ssl`, or in `sshTunnel`. */
  const placements = new Map<Readonly<Record<string, FieldClass>>, (key: string, value: string) => DatabaseConnection>([
    [CONNECTION_FIELDS, (key, value) => ({ ...base, [key]: value }) as DatabaseConnection],
    [SSL_FIELDS, (key, value) => ({ ...base, ssl: { ...ssl, [key]: value } })],
    [SSH_TUNNEL_FIELDS, (key, value) => ({ ...base, sshTunnel: { ...tunnel, [key]: value } })],
  ]);
  const placementOf = (map: Readonly<Record<string, FieldClass>>) => {
    const place = placements.get(map);
    if (place === undefined) throw new Error("a classification map has no placement in this test");
    return place;
  };
  const secretFields = SECRET_FIELD_MAPS.flatMap((map) =>
    Object.keys(map)
      .filter((key) => map[key] === "secret")
      .map((key) => ({ map, key })),
  );

  test("every classification map has a placement here", () => {
    expect(SECRET_FIELD_MAPS.filter((map) => !placements.has(map))).toEqual([]);
  });

  test("the walk reaches the secrets of all three maps", () => {
    const keys = secretFields.map(({ key }) => key);
    for (const known of ["password", "connectionString", "apiKeyId", "apiKeySecret", "clientKey", "privateKey"]) {
      expect(keys).toContain(known);
    }
  });

  test("changing any one of them alone changes the key", async () => {
    const unframed: string[] = [];
    for (const { map, key } of secretFields) {
      const place = placementOf(map);
      if ((await providerCacheKey(place(key, "one"))) === (await providerCacheKey(place(key, "two")))) {
        unframed.push(key);
      }
    }
    expect(unframed).toEqual([]);
  });

  test("the comparison can see two equal keys: a field framed nowhere leaves the key where it was", async () => {
    const place = placementOf(CONNECTION_FIELDS);
    expect(await providerCacheKey(place("color", "one"))).toBe(await providerCacheKey(place("color", "two")));
  });
});

/**
 * The public fields `credentialDigest` frames, each moved alone. The walk above reaches only the
 * fields classified `secret`, so these rows are kept by hand, as the digest's own list is: a field
 * added to the digest gets a row here, and a row whose field the digest drops turns red.
 */
describe("providerCacheKey frames every public field that decides who a connection opens as", () => {
  const rows: [string, DatabaseConnection, DatabaseConnection][] = [
    ["agentUser", { ...base, agentUser: "reader" }, { ...base, agentUser: "writer" }],
    ["ssl.mode", { ...base, ssl: { ...ssl, mode: "require" } }, { ...base, ssl }],
    ["ssl.caCert", { ...base, ssl: { ...ssl, caCert: "other-ca" } }, { ...base, ssl }],
    ["ssl.clientCert", { ...base, ssl: { ...ssl, clientCert: "other-cert" } }, { ...base, ssl }],
    ["ssl.rejectUnauthorized", { ...base, ssl: { ...ssl, rejectUnauthorized: false } }, { ...base, ssl }],
    ["saslMechanism", { ...base, saslMechanism: "SCRAM-SHA-256" }, { ...base, saslMechanism: "SCRAM-SHA-512" }],
    ["authSource", { ...base, authSource: "admin" }, { ...base, authSource: "app" }],
    ["allowInsecureAuth", { ...base, allowInsecureAuth: true }, base],
    ["dataServers", { ...base, dataServers: "a.internal:6648" }, { ...base, dataServers: "b.internal:6648" }],
    [
      "sshTunnel.authMethod",
      { ...base, sshTunnel: { ...tunnel, authMethod: "privateKey" } },
      { ...base, sshTunnel: tunnel },
    ],
    [
      "sshTunnel.hostKeyFingerprint",
      { ...base, sshTunnel: { ...tunnel, hostKeyFingerprint: "SHA256:one" } },
      { ...base, sshTunnel: { ...tunnel, hostKeyFingerprint: "SHA256:two" } },
    ],
  ];

  test.each(rows)("%s", async (_field, one, two) => {
    expect(await providerCacheKey(one)).not.toBe(await providerCacheKey(two));
  });

  test("an absent authSource and a named one answer different keys", async () => {
    expect(await providerCacheKey({ ...base, authSource: "admin" })).not.toBe(await providerCacheKey(base));
  });
});
