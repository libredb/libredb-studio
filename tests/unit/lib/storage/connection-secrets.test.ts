import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  CONNECTION_FIELDS,
  decryptConnections,
  encryptConnections,
  SSH_TUNNEL_FIELDS,
  SSL_FIELDS,
} from "@/lib/storage/connection-secrets";
import { ENVELOPE_VERSION, readSecret, resetStorageEncryptionKey } from "@/lib/storage/encryption";
import type { DatabaseConnection } from "@/lib/types";

const snapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  snapshot.JWT_SECRET = process.env.JWT_SECRET;
  snapshot.STORAGE_ENCRYPTION_KEY = process.env.STORAGE_ENCRYPTION_KEY;
  process.env.JWT_SECRET = "connection-secrets-test-jwt-secret-32";
  delete process.env.STORAGE_ENCRYPTION_KEY;
  resetStorageEncryptionKey();
});

afterEach(() => {
  if (snapshot.JWT_SECRET === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = snapshot.JWT_SECRET;
  if (snapshot.STORAGE_ENCRYPTION_KEY === undefined) delete process.env.STORAGE_ENCRYPTION_KEY;
  else process.env.STORAGE_ENCRYPTION_KEY = snapshot.STORAGE_ENCRYPTION_KEY;
  resetStorageEncryptionKey();
});

/** A connection carrying every secret-bearing field at once, each with a unique canary value. */
function fullConnection(): DatabaseConnection {
  return {
    id: "c1",
    name: "Prod",
    type: "postgres",
    host: "db.internal",
    port: 5432,
    user: "app",
    password: "CANARY-DB-PASSWORD",
    database: "prod",
    connectionString: "postgres://app:CANARY-IN-URL@db.internal:5432/prod",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    agentUser: "agent-ro",
    agentPassword: "CANARY-AGENT-PASSWORD",
    ssl: {
      mode: "verify-full",
      caCert: "-----BEGIN CERTIFICATE-----CA-----END CERTIFICATE-----",
      clientCert: "-----BEGIN CERTIFICATE-----CLIENT-----END CERTIFICATE-----",
      clientKey: "CANARY-TLS-CLIENT-KEY",
      rejectUnauthorized: true,
    },
    sshTunnel: {
      enabled: true,
      host: "bastion.internal",
      port: 22,
      username: "tunnel",
      authMethod: "privateKey",
      password: "CANARY-SSH-PASSWORD",
      privateKey: "CANARY-SSH-PRIVATE-KEY",
      passphrase: "CANARY-SSH-PASSPHRASE",
    },
  };
}

const CANARIES = [
  "CANARY-DB-PASSWORD",
  "CANARY-IN-URL",
  "CANARY-TLS-CLIENT-KEY",
  "CANARY-SSH-PASSWORD",
  "CANARY-SSH-PRIVATE-KEY",
  "CANARY-SSH-PASSPHRASE",
  "CANARY-AGENT-PASSWORD",
];

describe("the classification is exhaustive by construction", () => {
  // These three assertions are a tripwire, not the mechanism. The MECHANISM is that each map is
  // typed Record<keyof T, FieldClass>, so a new interface field breaks `bun run typecheck` before
  // any test runs. What these pin is the opposite direction: a field DELETED from the map (or a
  // map quietly widened to Record<string, FieldClass>) still gets caught here.
  test("every DatabaseConnection field is classified", () => {
    const classified = Object.keys(CONNECTION_FIELDS).sort();

    expect(classified).toEqual(
      [
        "agentPassword",
        "agentUser",
        "color",
        "connectionString",
        "createdAt",
        "database",
        "environment",
        "group",
        "host",
        "id",
        "instanceName",
        // Cassandra's required data centre (#424 Phase 4). A data-centre NAME, which
        // the server publishes itself in `system.local.data_center`, so `public`.
        "localDataCenter",
        "managed",
        "name",
        "password",
        "port",
        "seedId",
        "serviceName",
        "ssl",
        "sshTunnel",
        "type",
        "user",
      ].sort(),
    );
  });

  test("exactly the seven credential-bearing fields are classified secret", () => {
    const secrets = [
      ...Object.keys(CONNECTION_FIELDS).filter((k) => CONNECTION_FIELDS[k as never] === "secret"),
      ...Object.keys(SSL_FIELDS)
        .filter((k) => SSL_FIELDS[k as never] === "secret")
        .map((k) => `ssl.${k}`),
      ...Object.keys(SSH_TUNNEL_FIELDS)
        .filter((k) => SSH_TUNNEL_FIELDS[k as never] === "secret")
        .map((k) => `sshTunnel.${k}`),
    ].sort();

    expect(secrets).toEqual(
      [
        "agentPassword",
        "connectionString",
        "password",
        "ssl.clientKey",
        "sshTunnel.passphrase",
        "sshTunnel.password",
        "sshTunnel.privateKey",
      ].sort(),
    );
  });

  test("a certificate is not a secret and stays readable for diagnosis", () => {
    expect(SSL_FIELDS.caCert).toBe("public");
    expect(SSL_FIELDS.clientCert).toBe("public");
  });
});

describe("encryptConnections", () => {
  test("no canary survives anywhere in the serialized result", () => {
    const serialized = JSON.stringify(encryptConnections([fullConnection()]));

    for (const canary of CANARIES) {
      expect({ canary, present: serialized.includes(canary) }).toEqual({ canary, present: false });
    }
  });

  test("every secret field becomes a versioned envelope", () => {
    const [encrypted] = encryptConnections([fullConnection()]);
    const prefix = `${ENVELOPE_VERSION}:`;

    expect(encrypted.password?.startsWith(prefix)).toBe(true);
    expect(encrypted.connectionString?.startsWith(prefix)).toBe(true);
    expect(encrypted.agentPassword?.startsWith(prefix)).toBe(true);
    expect(encrypted.ssl?.clientKey?.startsWith(prefix)).toBe(true);
    expect(encrypted.sshTunnel?.password?.startsWith(prefix)).toBe(true);
    expect(encrypted.sshTunnel?.privateKey?.startsWith(prefix)).toBe(true);
    expect(encrypted.sshTunnel?.passphrase?.startsWith(prefix)).toBe(true);
  });

  test("leaves the fields an operator needs to identify the deployment readable", () => {
    const [encrypted] = encryptConnections([fullConnection()]);

    expect(encrypted.host).toBe("db.internal");
    expect(encrypted.user).toBe("app");
    expect(encrypted.database).toBe("prod");
    expect(encrypted.agentUser).toBe("agent-ro");
    expect(encrypted.ssl?.caCert).toContain("BEGIN CERTIFICATE");
  });

  test("does not mutate the caller's object", () => {
    const original = fullConnection();
    encryptConnections([original]);

    expect(original.password).toBe("CANARY-DB-PASSWORD");
    expect(original.sshTunnel?.privateKey).toBe("CANARY-SSH-PRIVATE-KEY");
  });

  test("does not double-envelope a value that is already sealed", () => {
    const once = encryptConnections([fullConnection()]);
    const twice = encryptConnections(once);

    expect(twice[0].password).toBe(once[0].password);
  });

  test("handles a connection with no ssl, no tunnel and no password", () => {
    const minimal: DatabaseConnection = {
      id: "c2",
      name: "Local SQLite",
      type: "sqlite",
      database: "/tmp/app.db",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    };

    expect(encryptConnections([minimal])).toEqual([minimal]);
  });

  test("leaves an empty-string secret alone rather than enveloping nothing", () => {
    const blank = { ...fullConnection(), password: "" };

    expect(encryptConnections([blank])[0].password).toBe("");
  });

  test("encrypts a real password shaped like an envelope, rather than writing it verbatim", () => {
    // A user whose actual password is "v2:hunter2" produces a two-segment string matching the
    // envelope version tag. readSecret classifies it "undecryptable" - the write path must not
    // treat that the same as "already sealed" and store it in the clear.
    const lookalike = { ...fullConnection(), password: "v2:hunter2" };
    const [sealed] = encryptConnections([lookalike]);

    expect(sealed.password).not.toBe("v2:hunter2");
    expect(readSecret(sealed.password as string).kind).toBe("decrypted");
    expect(decryptConnections([sealed]).connections[0].password).toBe("v2:hunter2");
  });

  test("encrypts a corrupted three-segment envelope claim rather than writing it verbatim", () => {
    // A three-segment value whose IV/body cannot be decoded or authenticated is also
    // "undecryptable", not "already sealed" - the write path must seal it, not pass it through.
    const corrupted = { ...fullConnection(), password: "v1:not-base64url-iv:not-base64url-body" };
    const [sealed] = encryptConnections([corrupted]);

    expect(sealed.password).not.toBe(corrupted.password);
    expect(readSecret(sealed.password as string).kind).toBe("decrypted");
  });
});

describe("decryptConnections", () => {
  test("round-trips every secret field", () => {
    const original = fullConnection();
    const result = decryptConnections(encryptConnections([original]));

    expect(result.undecryptable).toBe(0);
    expect(result.connections[0]).toEqual(original);
  });

  test("passes a pre-encryption store through untouched, which is the whole migration", () => {
    const legacy = fullConnection();
    const result = decryptConnections([legacy]);

    expect(result.undecryptable).toBe(0);
    expect(result.connections[0].password).toBe("CANARY-DB-PASSWORD");
  });

  test("reads a half-migrated record where only some fields were re-written", () => {
    const encrypted = encryptConnections([fullConnection()])[0];
    const halfMigrated = { ...encrypted, password: "STILL-PLAINTEXT" } as DatabaseConnection;
    const result = decryptConnections([halfMigrated]);

    expect(result.undecryptable).toBe(0);
    expect(result.connections[0].password).toBe("STILL-PLAINTEXT");
    expect(result.connections[0].sshTunnel?.privateKey).toBe("CANARY-SSH-PRIVATE-KEY");
  });

  test("omits an unreadable secret, keeps the record, and counts the loss", () => {
    const encrypted = encryptConnections([fullConnection()]);

    process.env.JWT_SECRET = "a-different-secret-that-cannot-open-it";
    resetStorageEncryptionKey();
    const result = decryptConnections(encrypted);

    // Seven unreadable fields on one record.
    expect(result.undecryptable).toBe(7);
    // The record SURVIVES. Dropping it would be persisted as a deletion by the write-through
    // cache on the next sync, destroying ciphertext a restored key could still have opened.
    expect(result.connections).toHaveLength(1);
    expect(result.connections[0].name).toBe("Prod");
    expect(result.connections[0].host).toBe("db.internal");
    // And the field is ABSENT, never the raw envelope: "v1:..." must never reach a driver.
    expect("password" in result.connections[0]).toBe(false);
    expect(result.connections[0].sshTunnel?.privateKey).toBeUndefined();
    expect(JSON.stringify(result.connections)).not.toContain(ENVELOPE_VERSION + ":");
  });

  test("counts across records rather than reporting only the first", () => {
    const encrypted = encryptConnections([fullConnection(), { ...fullConnection(), id: "c2" }]);

    process.env.JWT_SECRET = "a-different-secret-that-cannot-open-it";
    resetStorageEncryptionKey();

    expect(decryptConnections(encrypted).undecryptable).toBe(14);
  });

  test("an empty list is not an error", () => {
    expect(decryptConnections([])).toEqual({ connections: [], undecryptable: 0 });
  });
});
