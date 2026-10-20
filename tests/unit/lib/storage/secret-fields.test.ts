import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as connectionSecrets from "@/lib/storage/connection-secrets";
import * as secretFields from "@/lib/storage/secret-fields";
import {
  SECRET_FIELD_MAPS,
  type SecretFieldRecord,
  secretFieldValues,
  withoutSecretFields,
  withSecretFieldValues,
} from "@/lib/storage/secret-fields";

const everySecret: SecretFieldRecord = {
  id: "c1",
  name: "every secret",
  type: "postgres",
  host: "db",
  port: 5432,
  user: "app",
  database: "app",
  createdAt: "2026-10-20T00:00:00.000Z",
  password: "pw",
  connectionString: "postgres://app:pw@db/app",
  privateKey: "pk",
  privateKeyPassphrase: "pkp",
  agentPassword: "ap",
  apiKeyId: "kid",
  apiKeySecret: "ksec",
  ssl: { mode: "require", caCert: "ca", clientKey: "ck" },
  sshTunnel: {
    enabled: true,
    host: "bastion",
    port: 22,
    username: "tun",
    authMethod: "password",
    password: "tp",
    privateKey: "tk",
    passphrase: "tpp",
  },
};

const EVERY_VALUE = {
  password: "pw",
  connectionString: "postgres://app:pw@db/app",
  privateKey: "pk",
  privateKeyPassphrase: "pkp",
  agentPassword: "ap",
  apiKeyId: "kid",
  apiKeySecret: "ksec",
  "ssl.clientKey": "ck",
  "sshTunnel.password": "tp",
  "sshTunnel.privateKey": "tk",
  "sshTunnel.passphrase": "tpp",
};

const bare: SecretFieldRecord = { id: "c2", name: "bare", type: "mysql", createdAt: "2026-10-20T00:00:00.000Z" };

describe("splitting a connection into its public fields and its secrets", () => {
  test("secretFieldValues collects every secret path, and withoutSecretFields keeps the rest", () => {
    expect(secretFieldValues(everySecret)).toEqual(EVERY_VALUE);
    expect(withoutSecretFields(everySecret)).toEqual({
      id: "c1",
      name: "every secret",
      type: "postgres",
      host: "db",
      port: 5432,
      user: "app",
      database: "app",
      createdAt: "2026-10-20T00:00:00.000Z",
      ssl: { mode: "require", caCert: "ca" },
      sshTunnel: { enabled: true, host: "bastion", port: 22, username: "tun", authMethod: "password" },
    });
  });

  test("joining the split back gives the connection, with a string or a Date createdAt", () => {
    expect(withSecretFieldValues(withoutSecretFields(everySecret), secretFieldValues(everySecret))).toEqual(
      everySecret,
    );
    const dated = { ...everySecret, createdAt: new Date("2026-10-20T00:00:00.000Z") };
    expect(withSecretFieldValues(withoutSecretFields(dated), secretFieldValues(dated))).toEqual(dated);
  });

  test("no call mutates its input, and the join copies each container", () => {
    const before = structuredClone(everySecret);
    const stripped = withoutSecretFields(everySecret);
    const values = secretFieldValues(everySecret);
    const joined = withSecretFieldValues(stripped, values);
    expect(everySecret).toEqual(before);
    expect(stripped).toEqual(withoutSecretFields(before));
    expect(joined).not.toBe(stripped);
    expect(joined.ssl).not.toBe(stripped.ssl);
    expect(joined.sshTunnel).not.toBe(stripped.sshTunnel);
  });

  test("an empty value is neither collected nor dropped", () => {
    const blank = { ...everySecret, password: "", ssl: { mode: "require" as const, clientKey: "" } };
    const values = secretFieldValues(blank);
    expect(values).not.toHaveProperty("password");
    expect(values).not.toHaveProperty(["ssl.clientKey"]);
    expect(withoutSecretFields(blank).password).toBe("");
    expect(withoutSecretFields(blank).ssl).toEqual({ mode: "require", clientKey: "" });
    expect(withSecretFieldValues(withoutSecretFields(blank), values)).toEqual(blank);
  });

  test("a connection with no containers and no secrets splits to nothing", () => {
    expect(secretFieldValues(bare)).toEqual({});
    expect(withSecretFieldValues(bare, {})).toEqual(bare);
  });
});

describe("withSecretFieldValues refuses a path it must not write", () => {
  const stripped = withoutSecretFields(everySecret);

  for (const values of [
    { host: "x" },
    { ssl: "x" },
    { "ssl.mode": "x" },
    { "sshTunnel.username": "x" },
    { "tunnel.password": "x" },
    JSON.parse('{"__proto__":"x"}') as Record<string, string>,
  ]) {
    const path = Object.keys(values)[0];
    test(`"${path}" is not a secret path`, () => {
      expect(() => withSecretFieldValues(stripped, values)).toThrow(`"${path}" is not a secret field of a connection.`);
    });
  }

  test("a path whose container the connection does not have", () => {
    expect(() => withSecretFieldValues(bare, { "ssl.clientKey": "x" })).toThrow(
      '"ssl.clientKey" belongs in the connection\'s ssl object, which this connection does not have.',
    );
    expect(() => withSecretFieldValues(bare, { "sshTunnel.password": "x" })).toThrow(
      '"sshTunnel.password" belongs in the connection\'s sshTunnel object, which this connection does not have.',
    );
  });

  test("every path is checked before any is written", () => {
    expect(() => withSecretFieldValues(bare, { password: "x", "ssl.clientKey": "x" })).toThrow();
    expect(bare).not.toHaveProperty("password");
  });
});

describe("one classification, reached through connection-secrets too", () => {
  const isClassificationMap = (value: unknown): boolean => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const values = Object.values(value);
    return values.length > 0 && values.every((entry) => entry === "secret" || entry === "public" || entry === "nested");
  };

  test("the leaf's classification maps are exactly SECRET_FIELD_MAPS, and connection-secrets re-exports each", () => {
    const maps = Object.entries(secretFields).filter(([, value]) => isClassificationMap(value));
    expect(maps.map(([, value]) => value)).toEqual(expect.arrayContaining([...SECRET_FIELD_MAPS]));
    expect(maps).toHaveLength(SECRET_FIELD_MAPS.length);
    for (const [, value] of maps) expect(SECRET_FIELD_MAPS).toContain(value as never);
    for (const [name, value] of maps) {
      expect((connectionSecrets as Record<string, unknown>)[name]).toBe(value);
    }
    expect(connectionSecrets.SECRET_FIELD_MAPS).toBe(SECRET_FIELD_MAPS);
    expect(connectionSecrets.withoutSecretFields).toBe(withoutSecretFields);
  });

  test("the leaf's imports are type-only and it re-exports nothing", () => {
    const source = readFileSync(join(import.meta.dir, "../../../../src/lib/storage/secret-fields.ts"), "utf8");
    expect(source).not.toMatch(/^import(?!\s+type\s)/m);
    expect(source).not.toMatch(/^export\s+(\*|\{)[^;]*\bfrom\s/m);
  });
});
