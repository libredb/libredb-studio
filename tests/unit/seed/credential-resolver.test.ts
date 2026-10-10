import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { mergeDefaults } from "@/lib/seed/connection-filter";
import {
  resolveConnectionCredentials,
  resetPlaintextWarnings,
  UndefinedSeedVariableError,
} from "@/lib/seed/credential-resolver";
import type { SeedConnection } from "@/lib/seed/types";

const baseConn: SeedConnection = {
  id: "test",
  name: "Test",
  type: "postgres",
  host: "localhost",
  roles: ["*"],
};

/** What `run` throws; a run that throws nothing fails the test. */
function thrownBy(run: () => unknown): Error {
  try {
    run();
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected a throw, and nothing was thrown");
}

describe("credential-resolver", () => {
  beforeEach(() => {
    resetPlaintextWarnings();
  });

  afterEach(() => {
    delete process.env.MY_PASSWORD;
    delete process.env.MY_HOST;
    delete process.env.MY_USER;
    delete process.env.MY_DB;
    delete process.env.MY_CONN_STR;
    delete process.env.ELASTIC_API_KEY_ID;
    delete process.env.ELASTIC_API_KEY_SECRET;
    delete process.env.OXIA_DATA_SERVERS;
    delete process.env.DATABEND_WAREHOUSE;
    delete process.env.S3_REGION;
  });

  it("resolves ${VAR} in password field", () => {
    process.env.MY_PASSWORD = "secret123";
    const conn = { ...baseConn, password: "${MY_PASSWORD}" };
    const resolved = resolveConnectionCredentials(conn);
    expect(resolved.password).toBe("secret123");
  });

  it("resolves ${VAR} in connectionString field", () => {
    process.env.MY_CONN_STR = "mongodb://user:pass@host/db";
    const conn = { ...baseConn, connectionString: "${MY_CONN_STR}" };
    const resolved = resolveConnectionCredentials(conn);
    expect(resolved.connectionString).toBe("mongodb://user:pass@host/db");
  });

  it("resolves ${VAR} in user, host, database fields", () => {
    process.env.MY_USER = "admin";
    process.env.MY_HOST = "db.internal";
    process.env.MY_DB = "mydb";
    const conn = { ...baseConn, user: "${MY_USER}", host: "${MY_HOST}", database: "${MY_DB}" };
    const resolved = resolveConnectionCredentials(conn);
    expect(resolved.user).toBe("admin");
    expect(resolved.host).toBe("db.internal");
    expect(resolved.database).toBe("mydb");
  });

  it("resolves ${VAR} in both halves of an Elasticsearch API key pair", () => {
    process.env.ELASTIC_API_KEY_ID = "seed-key-id";
    process.env.ELASTIC_API_KEY_SECRET = "seed-key-secret";
    const conn: SeedConnection = {
      ...baseConn,
      type: "elasticsearch",
      apiKeyId: "${ELASTIC_API_KEY_ID}",
      apiKeySecret: "${ELASTIC_API_KEY_SECRET}",
    };
    const resolved = resolveConnectionCredentials(conn);
    expect(resolved.apiKeyId).toBe("seed-key-id");
    expect(resolved.apiKeySecret).toBe("seed-key-secret");
  });

  it("resolves ${VAR} in dataServers", () => {
    process.env.OXIA_DATA_SERVERS = "a.internal:6648,b.internal:6648";
    const conn: SeedConnection = { ...baseConn, dataServers: "${OXIA_DATA_SERVERS}" };
    const resolved = resolveConnectionCredentials(conn);
    expect(resolved.dataServers).toBe("a.internal:6648,b.internal:6648");
  });

  it("resolves ${VAR} in warehouse", () => {
    process.env.DATABEND_WAREHOUSE = "analytics";
    const conn: SeedConnection = { ...baseConn, type: "databend", warehouse: "${DATABEND_WAREHOUSE}" };
    const resolved = resolveConnectionCredentials(conn);
    expect(resolved.warehouse).toBe("analytics");
  });

  it("resolves ${VAR} in region", () => {
    process.env.S3_REGION = "eu-central-1";
    const conn: SeedConnection = { ...baseConn, region: "${S3_REGION}" };
    const resolved = resolveConnectionCredentials(conn);
    expect(resolved.region).toBe("eu-central-1");
  });

  it("names the region field when its variable is not defined, so a literal reference is never signed for", () => {
    const error = thrownBy(() => resolveConnectionCredentials({ ...baseConn, region: "${S3_REGION}" }));

    expect(error).toBeInstanceOf(UndefinedSeedVariableError);
    expect(error).toMatchObject({ variable: "S3_REGION", connectionId: "test", field: "region" });
  });

  it("throws an UndefinedSeedVariableError naming the variable, the connection and the field", () => {
    const error = thrownBy(() => resolveConnectionCredentials({ ...baseConn, password: "${NONEXISTENT_VAR}" }));

    expect(error).toBeInstanceOf(UndefinedSeedVariableError);
    expect(error).toMatchObject({
      name: "UndefinedSeedVariableError",
      variable: "NONEXISTENT_VAR",
      connectionId: "test",
      field: "password",
    });
    expect(error.message).toBe(
      'Environment variable NONEXISTENT_VAR is not defined (required by seed connection "test" field "password")',
    );
  });

  it("resolves a variable defined as the empty string to the empty string", () => {
    process.env.MY_PASSWORD = "";

    expect(resolveConnectionCredentials({ ...baseConn, password: "${MY_PASSWORD}" }).password).toBe("");
  });

  it("leaves fields without ${} pattern unchanged", () => {
    const conn = { ...baseConn, host: "static-host.internal", port: 5432 };
    const resolved = resolveConnectionCredentials(conn);
    expect(resolved.host).toBe("static-host.internal");
    expect(resolved.port).toBe(5432);
  });

  it("resolves each connection on its own: an undefined variable in one leaves the next untouched", () => {
    process.env.MY_PASSWORD = "good";
    const connections: SeedConnection[] = [
      { ...baseConn, id: "good", password: "${MY_PASSWORD}" },
      { ...baseConn, id: "bad", password: "${MISSING}" },
      { ...baseConn, id: "also-good", host: "static" },
    ];

    const outcomes = connections.map((conn) => {
      try {
        return resolveConnectionCredentials(conn).id;
      } catch (err) {
        return err instanceof UndefinedSeedVariableError ? `skipped ${err.connectionId}` : "another error";
      }
    });

    expect(outcomes).toEqual(["good", "skipped bad", "also-good"]);
  });

  it("does not throw for plaintext passwords, just warns", () => {
    const conn = { ...baseConn, id: "plain", password: "hardcoded_secret" };
    const resolved = resolveConnectionCredentials(conn);
    expect(resolved.password).toBe("hardcoded_secret");
  });
});

/**
 * The TLS material under `ssl` (#1089). On a Kubernetes control-plane etcd the node's client
 * certificate and key are the only credential, and the chart mounts the seed file from a ConfigMap, so
 * `ssl.caCert`, `ssl.clientCert` and `ssl.clientKey` resolve through `${ENV}` as the top-level fields
 * do: the ConfigMap then holds references, and a Secret the values.
 */
describe("credential-resolver: the TLS material under ssl (#1089)", () => {
  type SeedSsl = NonNullable<SeedConnection["ssl"]>;
  const withSsl = (ssl: SeedSsl): SeedConnection => ({ ...baseConn, id: "cluster", ssl });
  const messageOf = (run: () => unknown): string => {
    try {
      run();
    } catch (err) {
      return (err as Error).message;
    }
    return "(nothing thrown)";
  };

  afterEach(() => {
    delete process.env.SEED_TLS_MATERIAL;
    delete process.env.ETCD_CA;
    delete process.env.ETCD_CLIENT_CERT;
    delete process.env.ETCD_CLIENT_KEY;
  });

  it.each(["caCert", "clientCert", "clientKey"] as const)(
    "resolves ${VAR} in ssl.%s and keeps the rest of the ssl object",
    (field) => {
      process.env.SEED_TLS_MATERIAL = `resolved ${field}`;
      const ssl: SeedSsl = { mode: "verify-full", rejectUnauthorized: true };
      ssl[field] = "${SEED_TLS_MATERIAL}";
      const expected: SeedSsl = { mode: "verify-full", rejectUnauthorized: true };
      expected[field] = `resolved ${field}`;

      expect(resolveConnectionCredentials(withSsl(ssl)).ssl).toStrictEqual(expected);
    },
  );

  it("resolves the three together, the way one Secret carries them", () => {
    process.env.ETCD_CA = "CA-CERTIFICATE";
    process.env.ETCD_CLIENT_CERT = "CLIENT-CERTIFICATE";
    process.env.ETCD_CLIENT_KEY = "CLIENT-KEY";
    const resolved = resolveConnectionCredentials(
      withSsl({
        mode: "verify-full",
        caCert: "${ETCD_CA}",
        clientCert: "${ETCD_CLIENT_CERT}",
        clientKey: "${ETCD_CLIENT_KEY}",
      }),
    );

    expect(resolved.ssl).toStrictEqual({
      mode: "verify-full",
      caCert: "CA-CERTIFICATE",
      clientCert: "CLIENT-CERTIFICATE",
      clientKey: "CLIENT-KEY",
    });
  });

  it("carries a multi-line PKCS#8 key through the reference byte for byte", () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    // Vacuity: a value on one line would prove nothing about the line breaks.
    expect(privateKey.split("\n").length).toBeGreaterThan(20);
    process.env.ETCD_CLIENT_KEY = privateKey;

    const clientKey = resolveConnectionCredentials(withSsl({ mode: "verify-full", clientKey: "${ETCD_CLIENT_KEY}" }))
      .ssl?.clientKey;

    expect(clientKey).toBe(privateKey);
    // Still the key: node reads it back as the same PKCS#8 key.
    expect(createPrivateKey(clientKey ?? "").export({ type: "pkcs8", format: "pem" })).toBe(privateKey);
  });

  it("names ssl.clientKey, and no value, when the variable it references is unset", () => {
    process.env.ETCD_CA = "CA-CERTIFICATE-CANARY";
    const conn = withSsl({ mode: "verify-full", caCert: "${ETCD_CA}", clientKey: "${ETCD_CLIENT_KEY}" });

    expect(messageOf(() => resolveConnectionCredentials(conn))).toBe(
      'Environment variable ETCD_CLIENT_KEY is not defined (required by seed connection "cluster" field "ssl.clientKey")',
    );
  });

  it("carries the variable, the connection and ssl.clientKey on the error", () => {
    const error = thrownBy(() =>
      resolveConnectionCredentials(withSsl({ mode: "verify-full", clientKey: "${ETCD_CLIENT_KEY}" })),
    );

    expect(error).toBeInstanceOf(UndefinedSeedVariableError);
    expect(error).toMatchObject({ variable: "ETCD_CLIENT_KEY", connectionId: "cluster", field: "ssl.clientKey" });
  });

  it("leaves a connection with no ssl object unchanged", () => {
    expect(resolveConnectionCredentials(baseConn)).toStrictEqual(baseConn);
  });

  it("leaves an ssl object that holds no reference unchanged", () => {
    const conn = withSsl({
      mode: "verify-ca",
      rejectUnauthorized: true,
      caCert: "CA-PEM",
      clientCert: "CERT-PEM",
      clientKey: "KEY-PEM",
    });

    expect(resolveConnectionCredentials(conn)).toStrictEqual(conn);
  });

  it("never writes into the ssl object a connection shares with defaults.ssl", () => {
    // A connection with no ssl of its own takes the one defaults.ssl object (mergeDefaults), and the
    // parsed seed file is cached, so a write into it would put a resolved key into the cached file.
    process.env.ETCD_CLIENT_KEY = "CLIENT-KEY";
    const defaults = { ssl: { mode: "verify-full" as const, clientKey: "${ETCD_CLIENT_KEY}" } };
    const merged = [
      { ...baseConn, id: "first" },
      { ...baseConn, id: "second" },
    ].map((conn) => mergeDefaults(conn, defaults));
    // The premise: one object, shared.
    expect(merged[0].ssl).toBe(merged[1].ssl);

    const resolved = merged.map((conn) => resolveConnectionCredentials(conn));

    expect(resolved.map((conn) => conn.ssl?.clientKey)).toEqual(["CLIENT-KEY", "CLIENT-KEY"]);
    expect(defaults.ssl).toStrictEqual({ mode: "verify-full", clientKey: "${ETCD_CLIENT_KEY}" });
  });
});
