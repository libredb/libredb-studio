import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import {
  CONNECTION_FIELDS,
  decryptConnections,
  encryptConnections,
  type FieldClass,
  resealConnections,
  SSH_TUNNEL_FIELDS,
  SSL_FIELDS,
  withoutSecretFields,
} from "@/lib/storage/connection-secrets";
import { ENVELOPE_VERSION, openSecret, resetStorageEncryptionKey } from "@/lib/storage/encryption";
import { connectionBinding } from "@/lib/storage/envelope-binding";
import { secretFieldValues } from "@/lib/storage/secret-fields";
import type { DatabaseConnection } from "@/lib/types";
import { sealVersionOne } from "../../../helpers/storage-envelope-v1";

const OWNER = "alice";
const bindingOf = (owner: string, connection: DatabaseConnection, path: string) =>
  connectionBinding(owner, connection).field(path);

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
    queryTimeout: 120000,
    user: "app",
    password: "CANARY-DB-PASSWORD",
    database: "prod",
    connectionString: "postgres://app:CANARY-IN-URL@db.internal:5432/prod",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    agentUser: "agent-ro",
    agentPassword: "CANARY-AGENT-PASSWORD",
    apiKeyId: "CANARY-API-KEY-ID",
    apiKeySecret: "CANARY-API-KEY-SECRET",
    privateKey: "CANARY-SNOWFLAKE-PRIVATE-KEY",
    privateKeyPassphrase: "CANARY-SNOWFLAKE-PASSPHRASE",
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
  "CANARY-API-KEY-ID",
  "CANARY-API-KEY-SECRET",
  "CANARY-SNOWFLAKE-PRIVATE-KEY",
  "CANARY-SNOWFLAKE-PASSPHRASE",
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
        "agentReadRoots",
        "agentUser",
        // Db2's consent to a cleartext password (#786). A choice about the transport, so `public`.
        "allowInsecureAuth",
        // Elasticsearch's API key pair (#708). Unlike `user`, an id is one generated,
        // opaque half of a credential pair rather than a name an operator chose, so
        // both halves are classified secret below.
        "apiKeyId",
        "apiKeySecret",
        // MongoDB's auth database. A database NAME, so `public`; the password
        // checked against it is the secret and is classified below.
        "authSource",
        "color",
        "connectionString",
        "createdAt",
        // Oxia's data-server addresses. Addresses, as host is; the token they receive is the secret.
        "dataServers",
        "database",
        "schema",
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
        "queryTimeout",
        // Whether the provider refuses writes on this connection (#1089). A mode, not a credential:
        // it grants nothing, and the browser reads it to draw the Read-only marker.
        "readOnly",
        // The S3 signing region. A region NAME (`us-east-1`) that decides how a request is signed and grants nothing.
        "region",
        // Kafka's SASL mechanism (#1088). A mechanism NAME (`SCRAM-SHA-512`), which the
        // broker's own configuration lists in the clear, so `public`; the password it checks
        // is the secret and is classified above.
        "saslMechanism",
        "seedId",
        // Whether this browser reads the catalog when the connection opens (#765). A
        // display preference: it grants nothing and unlocks nothing.
        "skipObjectScan",
        "serviceName",
        "ssl",
        "sshTunnel",
        "type",
        "user",
        // The warehouse of Databend (design 6.1) and Snowflake. A compute NAME, which picks where a statement runs
        // and grants nothing, so `public`.
        "warehouse",
        // BigQuery's job location: a region name, which grants nothing, so `public`.
        "location",
        // Kubernetes' API path, namespace list and TLS server name: where requests go and what the tree draws, so
        // `public`; the token and the client key that authenticate them are classified as secrets.
        "apiPath",
        "namespaces",
        "tlsServerName",
        // An AMQP port: an address, as port is, so `public`.
        "amqpPort",
        // Snowflake's sign-in method and role: which credential is sent and what the statements may do, so `public`.
        // The PEM key and its passphrase are the credential and are classified as secrets.
        "authMethod",
        "privateKey",
        "privateKeyPassphrase",
        "role",
        // A security mode is a setting, and a thumbprint is the PUBLIC fingerprint of a public
        // certificate: it identifies a server and authenticates nobody (#1677).
        "securityMode",
        "serverCertificateThumbprint",
        "hostKeyFingerprint",
        // OPC UA's three deployment fields, seed-file only. A policy URI is published by the server,
        // and the other two are PATHS: the private key stays in the file the path names, which is
        // the reason this provider takes a path rather than a key.
        "securityPolicyUri",
        "clientCertificatePath",
        "clientPrivateKeyPath",
        // Modbus's register map: addresses on a device the user wrote down. Modbus TCP defines no
        // authentication at all, so there is nothing here to leak, and masking a document would
        // stop the person who wrote it from fixing it.
        "registerMap",
      ].sort(),
    );
  });

  test("exactly the eleven credential-bearing fields are classified secret", () => {
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
        "apiKeyId",
        "apiKeySecret",
        "connectionString",
        "password",
        "privateKey",
        "privateKeyPassphrase",
        "ssl.clientKey",
        "sshTunnel.passphrase",
        "sshTunnel.password",
        "sshTunnel.privateKey",
      ].sort(),
    );
  });

  test("exactly the thirty identity fields are classified identity", () => {
    // The identity set is part of the stored envelope format: moving an existing field into or out of it changes the
    // digest every sealed value of a record carrying that field was bound to, and those values then read as
    // undecryptable. A change to this list is a new envelope version with its own re-seal (docs/STORAGE.md).
    const identity = [
      ...Object.keys(CONNECTION_FIELDS).filter((k) => CONNECTION_FIELDS[k as never] === "identity"),
      ...Object.keys(SSL_FIELDS)
        .filter((k) => SSL_FIELDS[k as never] === "identity")
        .map((k) => `ssl.${k}`),
      ...Object.keys(SSH_TUNNEL_FIELDS)
        .filter((k) => SSH_TUNNEL_FIELDS[k as never] === "identity")
        .map((k) => `sshTunnel.${k}`),
    ].sort();

    expect(identity).toEqual(
      [
        "type",
        "host",
        "port",
        "user",
        "database",
        "serviceName",
        "instanceName",
        "authSource",
        "saslMechanism",
        "allowInsecureAuth",
        "dataServers",
        "apiPath",
        "tlsServerName",
        "amqpPort",
        "securityMode",
        "securityPolicyUri",
        "serverCertificateThumbprint",
        "hostKeyFingerprint",
        "clientCertificatePath",
        "clientPrivateKeyPath",
        "agentUser",
        "ssl.mode",
        "ssl.rejectUnauthorized",
        "ssl.caCert",
        "ssl.clientCert",
        "sshTunnel.enabled",
        "sshTunnel.host",
        "sshTunnel.port",
        "sshTunnel.username",
        "sshTunnel.hostKeyFingerprint",
      ].sort(),
    );
    expect(identity).toHaveLength(30);
  });

  test("a certificate is not a secret and stays readable for diagnosis", () => {
    // Readable, and bound into every sealed value of its connection: it decides whom the credential is sent to.
    expect(SSL_FIELDS.caCert).toBe("identity");
    expect(SSL_FIELDS.clientCert).toBe("identity");
  });

  test("a SASL mechanism names how the password is checked, and is no secret itself", () => {
    // Readable, and bound: PLAIN sends the password itself where SCRAM sends a proof.
    expect(CONNECTION_FIELDS.saslMechanism).toBe("identity");
  });

  test("the read-only mode is public, because the browser reads it to draw the marker (#1089)", () => {
    // Classified secret, it would be stripped from every managed seed the browser is sent
    // (`withoutSecretFields`), and a read-only seed would lose its marker and its Operations line.
    expect(CONNECTION_FIELDS.readOnly).toBe("public");
  });
});

describe("encryptConnections", () => {
  test("no canary survives anywhere in the serialized result", () => {
    const serialized = JSON.stringify(encryptConnections(OWNER, [fullConnection()]));

    for (const canary of CANARIES) {
      expect({ canary, present: serialized.includes(canary) }).toEqual({ canary, present: false });
    }
  });

  test("every secret field becomes a versioned envelope", () => {
    const [encrypted] = encryptConnections(OWNER, [fullConnection()]);
    const prefix = `${ENVELOPE_VERSION}:`;

    expect(prefix).toBe("v2:");
    expect(encrypted.password?.startsWith(prefix)).toBe(true);
    expect(encrypted.connectionString?.startsWith(prefix)).toBe(true);
    expect(encrypted.agentPassword?.startsWith(prefix)).toBe(true);
    expect(encrypted.ssl?.clientKey?.startsWith(prefix)).toBe(true);
    expect(encrypted.sshTunnel?.password?.startsWith(prefix)).toBe(true);
    expect(encrypted.sshTunnel?.privateKey?.startsWith(prefix)).toBe(true);
    expect(encrypted.sshTunnel?.passphrase?.startsWith(prefix)).toBe(true);
    expect(encrypted.apiKeyId?.startsWith(prefix)).toBe(true);
    expect(encrypted.apiKeySecret?.startsWith(prefix)).toBe(true);
  });

  test("leaves the fields an operator needs to identify the deployment readable", () => {
    const [encrypted] = encryptConnections(OWNER, [fullConnection()]);

    expect(encrypted.host).toBe("db.internal");
    expect(encrypted.user).toBe("app");
    expect(encrypted.database).toBe("prod");
    expect(encrypted.agentUser).toBe("agent-ro");
    expect(encrypted.ssl?.caCert).toContain("BEGIN CERTIFICATE");
  });

  test("does not mutate the caller's object", () => {
    const original = fullConnection();
    encryptConnections(OWNER, [original]);

    expect(original.password).toBe("CANARY-DB-PASSWORD");
    expect(original.sshTunnel?.privateKey).toBe("CANARY-SSH-PRIVATE-KEY");
  });

  test("does not double-envelope a value that is already sealed", () => {
    const once = encryptConnections(OWNER, [fullConnection()]);
    const twice = encryptConnections(OWNER, once);

    expect(twice).toEqual(once);
  });

  test("handles a connection with no ssl, no tunnel and no password", () => {
    const minimal: DatabaseConnection = {
      id: "c2",
      name: "Local SQLite",
      type: "sqlite",
      database: "/tmp/app.db",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    };

    expect(encryptConnections(OWNER, [minimal])).toEqual([minimal]);
  });

  test("leaves an empty-string secret alone rather than enveloping nothing", () => {
    const blank = { ...fullConnection(), password: "" };

    expect(encryptConnections(OWNER, [blank])[0].password).toBe("");
  });

  test("encrypts a real password shaped like an envelope, rather than writing it verbatim", () => {
    // A user whose actual password is shaped "v2:<text>" produces a two-segment string matching the envelope version
    // tag. It does not open, so the write path seals it as the text it is instead of storing it in the clear.
    const lookalike = { ...fullConnection(), password: `v2:${randomUUID()}` };
    const [sealed] = encryptConnections(OWNER, [lookalike]);

    expect(sealed.password).not.toBe(lookalike.password);
    expect(openSecret(sealed.password as string, bindingOf(OWNER, sealed, "password")).kind).toBe("v2");
    expect(decryptConnections(OWNER, [sealed], "v1-retired").connections[0].password).toBe(lookalike.password);
  });

  test("encrypts a corrupted three-segment envelope claim rather than writing it verbatim", () => {
    const corrupted = { ...fullConnection(), password: "v1:not-base64url-iv:not-base64url-body" };
    const [sealed] = encryptConnections(OWNER, [corrupted]);

    expect(sealed.password).not.toBe(corrupted.password);
    expect(openSecret(sealed.password as string, bindingOf(OWNER, sealed, "password")).kind).toBe("v2");
  });
});

describe("decryptConnections", () => {
  test("round-trips every secret field", () => {
    const original = fullConnection();
    const result = decryptConnections(OWNER, encryptConnections(OWNER, [original]), "v1-retired");

    expect(result.omitted).toEqual([]);
    expect(result.connections[0]).toEqual(original);
  });

  test("passes a pre-encryption store through untouched while v1 is accepted, which is the whole migration", () => {
    const legacy = fullConnection();
    const result = decryptConnections(OWNER, [legacy], "v1-accepted");

    expect(result.omitted).toEqual([]);
    expect(result.connections[0].password).toBe("CANARY-DB-PASSWORD");
  });

  test("reads a half-migrated record where only some fields were re-written", () => {
    const encrypted = encryptConnections(OWNER, [fullConnection()])[0];
    const unsealed = randomUUID();
    const halfMigrated = { ...encrypted, password: unsealed } as DatabaseConnection;
    const result = decryptConnections(OWNER, [halfMigrated], "v1-accepted");

    expect(result.omitted).toEqual([]);
    expect(result.connections[0].password).toBe(unsealed);
    expect(result.connections[0].sshTunnel?.privateKey).toBe("CANARY-SSH-PRIVATE-KEY");
  });

  test("omits an unreadable secret, keeps the record, and names the loss", () => {
    const encrypted = encryptConnections(OWNER, [fullConnection()]);

    process.env.JWT_SECRET = randomBytes(32).toString("base64url");
    resetStorageEncryptionKey();
    const result = decryptConnections(OWNER, encrypted, "v1-accepted");

    // Eleven unreadable fields on one record, each named by its connection and path.
    expect(result.omitted).toHaveLength(11);
    expect(result.omitted[0]).toEqual({ id: "c1", path: "password", reason: "unopenable" });
    // The record SURVIVES. Dropping it would be persisted as a deletion by the write-through
    // cache on the next sync, destroying ciphertext a restored key could still have opened.
    expect(result.connections).toHaveLength(1);
    expect(result.connections[0].name).toBe("Prod");
    expect(result.connections[0].host).toBe("db.internal");
    // And the field is ABSENT, never the raw envelope: "v2:..." must never reach a driver.
    expect("password" in result.connections[0]).toBe(false);
    expect(result.connections[0].sshTunnel?.privateKey).toBeUndefined();
    expect(JSON.stringify(result.connections)).not.toContain(ENVELOPE_VERSION + ":");
  });

  test("names the losses across records rather than reporting only the first", () => {
    const encrypted = encryptConnections(OWNER, [fullConnection(), { ...fullConnection(), id: "c2" }]);

    process.env.JWT_SECRET = randomBytes(32).toString("base64url");
    resetStorageEncryptionKey();
    const { omitted } = decryptConnections(OWNER, encrypted, "v1-accepted");

    expect(omitted).toHaveLength(22);
    expect(new Set(omitted.map(({ id }) => id))).toEqual(new Set(["c1", "c2"]));
  });

  test("an empty list is not an error", () => {
    expect(decryptConnections(OWNER, [], "v1-retired")).toEqual({ connections: [], omitted: [] });
  });
});

/** A connection whose every secret path holds a generated value, returned with those values by path. */
function generatedConnection(overrides: Record<string, unknown> = {}): {
  connection: DatabaseConnection;
  values: Record<string, string>;
} {
  const connection = {
    ...fullConnection(),
    ...overrides,
    password: randomUUID(),
    connectionString: `postgres://app:${randomUUID()}@db.internal:5432/prod`,
    agentPassword: randomUUID(),
    apiKeyId: randomUUID(),
    apiKeySecret: randomUUID(),
    privateKey: randomUUID(),
    privateKeyPassphrase: randomUUID(),
    ssl: { ...fullConnection().ssl, clientKey: randomUUID() },
    sshTunnel: { ...fullConnection().sshTunnel!, password: randomUUID(), privateKey: randomUUID(), passphrase: randomUUID() },
  } as DatabaseConnection;
  return { connection, values: secretFieldValues(connection) };
}

const SECRET_PATHS = [
  "password",
  "connectionString",
  "privateKey",
  "privateKeyPassphrase",
  "agentPassword",
  "apiKeyId",
  "apiKeySecret",
  "ssl.clientKey",
  "sshTunnel.password",
  "sshTunnel.privateKey",
  "sshTunnel.passphrase",
];

/** Reads one secret path of a connection, `ssl.clientKey` and `sshTunnel.password` included. */
function at(connection: DatabaseConnection, path: string): unknown {
  const [head, tail] = path.split(".");
  const value = (connection as unknown as Record<string, unknown>)[head];
  return tail === undefined ? value : (value as Record<string, unknown> | undefined)?.[tail];
}

/** A copy of `connection` with `value` written at `path`. */
function withAt(connection: DatabaseConnection, path: string, value: unknown): DatabaseConnection {
  const copy = structuredClone(connection) as unknown as Record<string, Record<string, unknown>>;
  const [head, tail] = path.split(".");
  if (tail === undefined) (copy as unknown as Record<string, unknown>)[head] = value;
  else copy[head] = { ...copy[head], [tail]: value };
  return copy as unknown as DatabaseConnection;
}

describe("the binding", () => {
  test("a value written and read back for the same owner, connection and identity opens, for every secret path", () => {
    const { connection, values } = generatedConnection();
    expect(Object.keys(values).sort()).toEqual([...SECRET_PATHS].sort());
    const stored = JSON.parse(JSON.stringify(encryptConnections(OWNER, [connection])));

    const read = decryptConnections(OWNER, stored, "v1-retired");

    expect(read.omitted).toEqual([]);
    expect(secretFieldValues(read.connections[0])).toEqual(values);
  });

  test("a value moved to another connection of the row does not open, and is named", () => {
    const first = generatedConnection({ id: "first" });
    const second = generatedConnection({ id: "second" });
    const [sealedFirst, sealedSecond] = encryptConnections(OWNER, [first.connection, second.connection]);
    const moved = { ...sealedSecond, password: sealedFirst.password };

    const read = decryptConnections(OWNER, [sealedFirst, moved], "v1-accepted");

    expect(read.connections[0].password).toBe(first.values.password);
    expect("password" in read.connections[1]).toBe(false);
    expect(read.omitted).toEqual([{ id: "second", path: "password", reason: "unopenable" }]);
  });

  test("a value moved to another field does not open", () => {
    const { connection } = generatedConnection();
    const [sealed] = encryptConnections(OWNER, [connection]);
    const moved = withAt(sealed, "sshTunnel.password", sealed.password);

    const read = decryptConnections(OWNER, [moved], "v1-accepted");

    expect(read.omitted).toEqual([{ id: "c1", path: "sshTunnel.password", reason: "unopenable" }]);
  });

  test("a value moved into another owner's row does not open", () => {
    const { connection } = generatedConnection();
    const sealed = encryptConnections(OWNER, [connection]);

    const read = decryptConnections(`other-${randomUUID()}`, sealed, "v1-accepted");

    expect(read.omitted).toHaveLength(SECRET_PATHS.length);
    expect(read.omitted.every(({ reason }) => reason === "unopenable")).toBe(true);
  });

  test("a value whose connection changed an identity field does not open, for every identity field", () => {
    const { connection } = generatedConnection();
    const [sealed] = encryptConnections(OWNER, [connection]);
    const outcomes: Record<string, number> = {};
    for (const [map, container] of [
      [CONNECTION_FIELDS, ""],
      [SSL_FIELDS, "ssl"],
      [SSH_TUNNEL_FIELDS, "sshTunnel"],
    ] as const) {
      for (const [key, fieldClass] of Object.entries(map)) {
        if (fieldClass !== "identity") continue;
        const path = container === "" ? key : `${container}.${key}`;
        const changed = withAt(sealed, path, `changed ${randomUUID()}`);
        outcomes[path] = decryptConnections(OWNER, [changed], "v1-accepted").omitted.length;
      }
    }

    expect(Object.keys(outcomes)).toHaveLength(30);
    expect(Object.values(outcomes).every((count) => count === SECRET_PATHS.length)).toBe(true);
  });

  test("a value whose connection changed only a public field still opens", () => {
    const { connection, values } = generatedConnection();
    const [sealed] = encryptConnections(OWNER, [connection]);
    const failures: string[] = [];
    for (const [map, container] of [
      [CONNECTION_FIELDS, ""],
      [SSL_FIELDS, "ssl"],
      [SSH_TUNNEL_FIELDS, "sshTunnel"],
    ] as const) {
      for (const [key, fieldClass] of Object.entries(map)) {
        if (fieldClass !== "public" || key === "id") continue;
        const path = container === "" ? key : `${container}.${key}`;
        const read = decryptConnections(OWNER, [withAt(sealed, path, `changed ${randomUUID()}`)], "v1-retired");
        if (read.omitted.length > 0 || secretFieldValues(read.connections[0]).password !== values.password) {
          failures.push(path);
        }
      }
    }

    expect(failures).toEqual([]);
  });

  test("the write keeps a v2 value that opens for the record as written and seals anything else as text, a v1 envelope and another connection's v2 envelope included", () => {
    const { connection } = generatedConnection();
    const [sealed] = encryptConnections(OWNER, [connection]);
    const [elsewhere] = encryptConnections(OWNER, [generatedConnection({ id: "elsewhere" }).connection]);
    const versionOne = sealVersionOne(randomUUID());
    const claim = `v2:${randomUUID()}`;

    const [kept] = encryptConnections(OWNER, [sealed]);
    expect(kept.password).toBe(sealed.password);

    for (const submitted of [versionOne, elsewhere.password as string, claim]) {
      const [written] = encryptConnections(OWNER, [{ ...sealed, password: submitted }]);
      expect(written.password).not.toBe(submitted);
      expect(decryptConnections(OWNER, [written], "v1-retired").connections[0].password).toBe(submitted);
    }
  });

  test("a v1 value and an unsealed value open while v1 is accepted and are refused by name once it is retired", () => {
    const secret = randomUUID();
    const plain = randomUUID();
    const legacy = {
      id: "c1",
      name: "Prod",
      type: "postgres",
      host: "db.internal",
      createdAt: "2026-01-01T00:00:00.000Z",
      password: sealVersionOne(secret),
      agentUser: "agent-ro",
      agentPassword: plain,
    } as unknown as DatabaseConnection;

    const accepted = decryptConnections(OWNER, [legacy], "v1-accepted");
    expect(accepted.omitted).toEqual([]);
    expect([accepted.connections[0].password, accepted.connections[0].agentPassword]).toEqual([secret, plain]);

    const retired = decryptConnections(OWNER, [legacy], "v1-retired");
    expect(retired.omitted).toEqual([
      { id: "c1", path: "password", reason: "retired" },
      { id: "c1", path: "agentPassword", reason: "retired" },
    ]);
    expect("password" in retired.connections[0]).toBe(false);
    expect("agentPassword" in retired.connections[0]).toBe(false);
  });

  test("resealConnections re-seals v1 and unsealed values, keeps v2 values that open, and leaves and names the rest", () => {
    const { connection, values } = generatedConnection();
    const [sealed] = encryptConnections(OWNER, [connection]);
    const unopenable = `v2:${randomBytes(12).toString("base64url")}:${randomBytes(32).toString("base64url")}`;
    const stored = {
      ...sealed,
      password: sealVersionOne(values.password),
      agentPassword: values.agentPassword,
      apiKeyId: unopenable,
    } as DatabaseConnection;

    const result = resealConnections(OWNER, [stored]);

    expect(result.resealed).toBe(2);
    expect(result.kept).toBe(SECRET_PATHS.length - 3);
    expect(result.unopened).toEqual([{ id: "c1", path: "apiKeyId", reason: "unopenable" }]);
    const [after] = result.connections;
    expect(after.apiKeyId).toBe(unopenable);
    expect(after.privateKey).toBe(sealed.privateKey);
    expect(after.password?.startsWith("v2:")).toBe(true);
    expect(after.agentPassword?.startsWith("v2:")).toBe(true);
    const read = decryptConnections(OWNER, [after], "v1-retired");
    expect(read.connections[0].password).toBe(values.password);
    expect(read.connections[0].agentPassword).toBe(values.agentPassword);
    expect(read.omitted).toEqual([{ id: "c1", path: "apiKeyId", reason: "unopenable" }]);
  });
});

describe("withoutSecretFields", () => {
  const keysOf = (map: Record<string, FieldClass>, fieldClass: FieldClass): string[] =>
    Object.keys(map).filter((key) => map[key] === fieldClass);
  const groups = (conn: DatabaseConnection) =>
    [
      [conn as unknown as Record<string, unknown>, CONNECTION_FIELDS],
      [conn.ssl as unknown as Record<string, unknown>, SSL_FIELDS],
      [conn.sshTunnel as unknown as Record<string, unknown>, SSH_TUNNEL_FIELDS],
    ] as const;

  // Derived from the maps rather than listed, so a field classified secret tomorrow is covered
  // by this test the day it is classified.
  test("removes every field the maps classify as secret", () => {
    const original = fullConnection();
    for (const [group, map] of groups(original)) {
      for (const key of keysOf(map, "secret")) {
        // Control: the fixture really carries each secret, so the absence below is not vacuous.
        expect(typeof group[key]).toBe("string");
      }
    }

    const withheld = withoutSecretFields(original);
    for (const [group, map] of groups(withheld)) {
      for (const key of keysOf(map, "secret")) {
        expect(key in group).toBe(false);
      }
    }
    const serialized = JSON.stringify(withheld);
    for (const canary of CANARIES) {
      expect(serialized).not.toContain(canary);
    }
  });

  test("keeps every public field as it was", () => {
    const original = fullConnection();
    const withheld = withoutSecretFields(fullConnection());
    const before = groups(original);
    const after = groups(withheld);
    const readable = (map: Record<string, FieldClass>): string[] =>
      Object.keys(map).filter((key) => map[key] !== "secret" && map[key] !== "nested");
    for (const [index, [group, map]] of before.entries()) {
      for (const key of readable(map)) {
        expect(after[index][0][key]).toEqual(group[key]);
      }
    }
  });

  // An empty value holds nothing to withhold, and the walker skips it as encryption does.
  test("leaves an empty secret as it is", () => {
    const withheld = withoutSecretFields({ ...fullConnection(), password: "" });
    expect(withheld.password).toBe("");
    expect("apiKeySecret" in withheld).toBe(false);
  });

  test("a managed connection keeps its warehouse and loses its password", () => {
    const managed: DatabaseConnection = { ...fullConnection(), managed: true, warehouse: "small-xy2t" };
    const withheld = withoutSecretFields(managed);
    expect(withheld.warehouse).toBe("small-xy2t");
    expect("password" in withheld).toBe(false);
    expect(CONNECTION_FIELDS.warehouse).toBe("public");
  });

  test("a managed connection keeps dataServers and loses its password", () => {
    const managed: DatabaseConnection = {
      ...fullConnection(),
      managed: true,
      dataServers: "oxia-0.internal:6648,oxia-1.internal:6648",
    };
    const withheld = withoutSecretFields(managed);
    expect(withheld.dataServers).toBe("oxia-0.internal:6648,oxia-1.internal:6648");
    expect("password" in withheld).toBe(false);
    expect(CONNECTION_FIELDS.dataServers).toBe("identity");
  });

  test("leaves the connection it was given untouched", () => {
    const original = fullConnection();
    withoutSecretFields(original);
    expect(original.password).toBe("CANARY-DB-PASSWORD");
    expect(original.ssl?.clientKey).toBe("CANARY-TLS-CLIENT-KEY");
    expect(original.sshTunnel?.privateKey).toBe("CANARY-SSH-PRIVATE-KEY");
  });
});
