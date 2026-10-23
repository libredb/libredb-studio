import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as connectionSecrets from "@/lib/storage/connection-secrets";
import * as secretFields from "@/lib/storage/secret-fields";
import {
  CONNECTION_FIELDS,
  type FieldClass,
  SECRET_FIELD_MAPS,
  type SecretFieldRecord,
  SSH_TUNNEL_FIELDS,
  SSL_FIELDS,
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

  test("a container that is not an object, as a hand-edited settings entry can hold", () => {
    const notObjects = [
      { ...bare, ssl: "require" },
      { ...bare, ssl: ["ck"] },
      { ...bare, sshTunnel: true },
      { ...bare, sshTunnel: null },
    ] as unknown as SecretFieldRecord[];
    for (const connection of notObjects) {
      const container = "ssl" in connection ? "ssl" : "sshTunnel";
      const path = container === "ssl" ? "ssl.clientKey" : "sshTunnel.password";
      expect(() => withSecretFieldValues(connection, { [path]: "x" })).toThrow(
        `"${path}" belongs in the connection's ${container} object, which this connection does not have.`,
      );
    }
  });

  test("a container no path writes into is left exactly as it was", () => {
    const connection = { ...bare, ssl: "require" } as unknown as SecretFieldRecord;
    expect(withSecretFieldValues(connection, { password: "x" })).toEqual({
      ...bare,
      ssl: "require",
      password: "x",
    } as unknown as SecretFieldRecord);
  });

  test("the input is unchanged after a throw", () => {
    const connection = { ...bare };
    expect(() => withSecretFieldValues(connection, { password: "x", "ssl.clientKey": "x" })).toThrow();
    expect(connection).toEqual(bare);
  });
});

/**
 * The cases above are samples. These read every field of every map instead, so the paths the join writes cannot
 * drift from the paths the walk visits in either direction: a path written but never walked lets a stored secret
 * overwrite a public field, and a path walked but refused splits a connection that cannot be joined back.
 */
describe("withSecretFieldValues writes exactly the paths walkSecretFields visits, for every field of every map", () => {
  /** Where the fields of each map sit on a connection: at its root (""), or in the container of that name. */
  const placements = new Map<Readonly<Record<string, FieldClass>>, string>([
    [CONNECTION_FIELDS, ""],
    [SSL_FIELDS, "ssl"],
    [SSH_TUNNEL_FIELDS, "sshTunnel"],
  ]);
  const fields = SECRET_FIELD_MAPS.flatMap((map) => {
    const container = placements.get(map);
    if (container === undefined) return [];
    return Object.entries(map).map(([key, fieldClass]) => ({
      key,
      fieldClass,
      container,
      path: container === "" ? key : `${container}.${key}`,
    }));
  });
  const secretPaths = fields.filter(({ fieldClass }) => fieldClass === "secret").map(({ path }) => path);
  const otherPaths = fields.filter(({ fieldClass }) => fieldClass !== "secret").map(({ path }) => path);

  /** Every field that is not a container holds a value of its own, so a value written at the wrong path shows. */
  const valueOf = (path: string) => `value of ${path}`;
  const record: Record<string, unknown> = {};
  for (const { key, fieldClass, container, path } of fields) {
    if (fieldClass === "nested") continue;
    const target = container === "" ? record : ((record[container] ??= {}) as Record<string, unknown>);
    target[key] = valueOf(path);
  }
  const everyField = record as unknown as SecretFieldRecord;

  test("every classification map has a placement here, and every container CONNECTION_FIELDS names is one", () => {
    expect(SECRET_FIELD_MAPS.filter((map) => !placements.has(map))).toEqual([]);
    const containers = Object.entries(CONNECTION_FIELDS)
      .filter(([, fieldClass]) => fieldClass === "nested")
      .map(([key]) => key);
    expect(containers.sort()).toEqual([...placements.values()].filter((container) => container !== "").sort());
  });

  test("the walk collects exactly the secret paths of a connection that sets every field", () => {
    expect(secretPaths).toEqual(expect.arrayContaining(["password", "ssl.clientKey", "sshTunnel.passphrase"]));
    expect(secretFieldValues(everyField)).toEqual(Object.fromEntries(secretPaths.map((path) => [path, valueOf(path)])));
  });

  test("the join writes every one of them back", () => {
    expect(withSecretFieldValues(withoutSecretFields(everyField), secretFieldValues(everyField))).toEqual(everyField);
  });

  test("the join refuses the path of every field the maps do not call secret", () => {
    expect(otherPaths).toEqual(expect.arrayContaining(["host", "ssl", "ssl.caCert", "sshTunnel.hostKeyFingerprint"]));
    const stripped = withoutSecretFields(everyField);
    const outcome = (path: string): string => {
      try {
        withSecretFieldValues(stripped, { [path]: "x" });
        return "written";
      } catch (error) {
        return (error as Error).message;
      }
    };
    expect(Object.fromEntries(otherPaths.map((path) => [path, outcome(path)]))).toEqual(
      Object.fromEntries(otherPaths.map((path) => [path, `"${path}" is not a secret field of a connection.`])),
    );
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

  const leafPath = join(import.meta.dir, "../../../../src/lib/storage/secret-fields.ts");

  test("the leaf's imports are type-only and it re-exports nothing", () => {
    const source = readFileSync(leafPath, "utf8");
    expect(source).not.toMatch(/^import(?!\s+type\s)/m);
    expect(source).not.toMatch(/^export\s+(\*|\{)[^;]*\bfrom\s/m);
  });

  test("a bundle of the leaf holds the leaf alone, whatever form an import takes", async () => {
    // The source check above cannot see an import() or a require() inside a function body; the bundler resolves both.
    const { metafile } = await Bun.build({ entrypoints: [leafPath], target: "node", metafile: true });
    const inputs = Object.entries(metafile!.inputs).map(([input, { imports }]) => ({ input: resolve(input), imports }));
    expect(inputs).toEqual([{ input: leafPath, imports: [] }]);
  });
});
