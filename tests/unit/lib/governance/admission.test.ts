/**
 * Row admission under governance (docs/GOVERNANCE.md#row-admission-and-skip-codes): which rows of `connections_v1`
 * Studio serves, and why it skips the rest.
 *
 * Every case seals real `lsb1` envelopes with the test sealer and opens them with Studio's own opener, so an admitted
 * row also proves that admission bound each envelope to its own row: connection id, level, engine and the definition
 * exactly as the governance source returned it. A skip is checked against the shape the manifest publishes for the
 * heartbeat, `{kind, id, level?, path?, code}`, which names the row, the level and the field and never a value.
 */
import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  type AdmissionOptions,
  type AdmissionResult,
  admitConnectionRows,
  type ConnectionRow,
  type SkippedItem,
} from "@/lib/governance/admission";
import { PLAINTEXT_KEYS, SKIP_CODES, SkippedItemSchema } from "@/lib/governance/contract";
import { type EnvelopeCode, x25519PrivateKey } from "@/lib/governance/hpke";
import { resetGovernanceKeyring } from "@/lib/governance/keyring";
import { type Keyring, type OpenedSecret, openSealedSecret, type SecretBinding } from "@/lib/governance/lsb1";
import { openGovernedSecret } from "@/lib/governance/secrets";
import { keyringFileOf, removeKeyringFiles, testKey } from "../../../helpers/governance/keyring-file";
import { sealSecret } from "../../../helpers/governance/lsb1-seal";

const ROOT = path.resolve(import.meta.dir, "../../../..");

interface Manifest {
  readonly definitionAllowlist: readonly { readonly path: string; readonly domain: Record<string, unknown> }[];
  readonly heartbeat: { readonly skipped: { readonly schema: Record<string, unknown> } };
}

/** The published manifest, which a control plane builds its connection form and its heartbeat reader from. */
const MANIFEST = JSON.parse(
  readFileSync(path.join(ROOT, "tests/fixtures/governance/contract-v1.json"), "utf8"),
) as Manifest;

/** The heartbeat's `skipped` column as the manifest publishes it, a JSON Schema. */
const SKIPPED_SHAPE = z.fromJSONSchema(MANIFEST.heartbeat.skipped.schema);

const KEY = testKey();
const KEYRING: Keyring = new Map([[KEY.kid, x25519PrivateKey(KEY.raw)]]);

/** Every binding admission asked to open, in order, so a case can tell which envelopes it tried. */
const opened: SecretBinding[] = [];

const OPTIONS: AdmissionOptions = {
  allowedEngines: ["postgres", "mysql", "mssql", "oracle", "mongodb", "redis"],
  openSecret: (envelope, binding) => {
    opened.push(binding);
    return openSealedSecret(KEYRING, envelope, binding);
  },
};

const admit = (rows: readonly ConnectionRow[], options: Partial<AdmissionOptions> = {}): AdmissionResult =>
  admitConnectionRows(rows, { ...OPTIONS, ...options });

/** The heartbeat items of a result's skips. */
const itemsOf = (result: AdmissionResult) => result.skipped.map((skip) => skip.item);

const ID = "3f6c2a91-0d4e-4b7a-9e15-c8a2f7d64b03";
const DEFINITION = { host: "db.example.internal", port: 5432, database: "orders" };
const READ = { user: "reader", password: "example-only-read-password" };
const WRITE = { user: "writer", password: "example-only-write-password" };

/** Envelope text admission must never reach for: it does not have the `lsb1` form, so it could not open anyway. */
const UNOPENED = "lsb1.never-opened";

const bindingOf = (
  connectionId: string,
  level: "read" | "write",
  engine = "postgres",
  definition: Readonly<Record<string, unknown>> = DEFINITION,
): SecretBinding => ({ connectionId, level, engine, definition });

interface RowOptions {
  readonly id?: string;
  readonly engine?: string;
  readonly definition?: Readonly<Record<string, unknown>>;
  /** The credential sealed into `read_secret` for the row's own binding. */
  readonly read?: Readonly<Record<string, unknown>>;
  /** The credential sealed into `write_secret` for the row's own binding; without one the column is NULL. */
  readonly write?: Readonly<Record<string, unknown>>;
  /** Columns as the governance source returns them, applied last; a secret given here is not sealed. */
  readonly columns?: Readonly<Record<string, unknown>>;
}

/** A `connections_v1` row with every column the snapshot reads. */
function connectionRow(options: RowOptions = {}): ConnectionRow {
  const id = options.id ?? ID;
  const engine = options.engine ?? "postgres";
  const definition = options.definition ?? DEFINITION;
  const columns = options.columns ?? {};
  const sealed = (level: "read" | "write", secret: Readonly<Record<string, unknown>>) =>
    sealSecret(KEY.publicKey, bindingOf(id, level, engine, definition), secret);
  return {
    connection_id: id,
    name: "Orders",
    engine,
    environment: "production",
    group_name: "Sales",
    color: "#1f6feb",
    definition,
    read_secret: "read_secret" in columns ? undefined : sealed("read", options.read ?? READ),
    write_secret: "write_secret" in columns || options.write === undefined ? null : sealed("write", options.write),
    mcp_enabled: false,
    updated_at: new Date("2026-10-14T12:00:00.000Z"),
    ...columns,
  };
}

/** The skip item of a row skipped for `code`, with the level and path given. */
const skipItem = (
  id: string,
  code: SkippedItem["code"],
  at: { readonly level?: SkippedItem["level"]; readonly path?: string } = {},
): SkippedItem => ({
  kind: "connection",
  id,
  ...at,
  code,
});

beforeEach(() => {
  opened.length = 0;
});

afterAll(() => {
  removeKeyringFiles();
});

describe("admitConnectionRows", () => {
  test("a row written as the contract says is admitted with a read and a write record, each bound to its own row", () => {
    const definition = { ...DEFINITION };
    const row = connectionRow({ definition, write: WRITE });
    const result = admit([row]);

    expect(result.skipped).toEqual([]);
    expect(result.admitted).toHaveLength(1);
    const [connection] = result.admitted;
    expect(connection.id).toBe(ID);
    expect(connection.read).toMatchObject({
      id: `seed:${ID}`,
      seedId: ID,
      name: "Orders",
      type: "postgres",
      environment: "production",
      group: "Sales",
      color: "#1f6feb",
      managed: true,
      roles: ["*"],
      literal: true,
      mcp: false,
      host: "db.example.internal",
      port: 5432,
      database: "orders",
      user: "reader",
      password: "example-only-read-password",
    });
    expect(connection.write).toMatchObject({ id: `seed:${ID}`, literal: true, user: "writer" });
    expect(connection.write?.password).toBe("example-only-write-password");

    // Each envelope was opened for its own level, with the definition exactly as the row holds it.
    expect(opened).toEqual([bindingOf(ID, "read"), bindingOf(ID, "write")]);
    expect(opened[0].definition).toBe(definition);
    // And kept as read, so a reload tells a credential sealed again from the one its providers were opened with.
    expect(connection.envelopes).toEqual({ read: String(row.read_secret), write: String(row.write_secret) });
  });

  test("a definition carrying password is skipped as DEFINITION_HAS_SECRET at path password with no value in the skip", () => {
    const leaked = "example-only-leaked-password";
    const result = admit([connectionRow({ definition: { ...DEFINITION, password: leaked } })]);

    expect(result.admitted).toEqual([]);
    expect(result.skipped).toEqual([{ item: skipItem(ID, "DEFINITION_HAS_SECRET", { path: "password" }) }]);
    expect(JSON.stringify(result.skipped)).not.toContain(leaked);
    // A refused definition never reaches the cipher.
    expect(opened).toEqual([]);
  });

  test("every lsb1 plaintext key, agentUser, agentPassword, sshTunnel and ssl.clientKey is DEFINITION_HAS_SECRET", () => {
    const secrets: readonly (readonly [string, Readonly<Record<string, unknown>>])[] = [
      ...PLAINTEXT_KEYS.map((key) => [key, { [key]: "example-only-secret-value" }] as const),
      ["agentUser", { agentUser: "agent" }],
      ["agentPassword", { agentPassword: "example-only-secret-value" }],
      ["sshTunnel", { sshTunnel: { host: "bastion.example.internal", user: "jump" } }],
      ["ssl.clientKey", { ssl: { mode: "verify-full", clientKey: "example-only-secret-value" } }],
    ];
    for (const [field, extra] of secrets) {
      const result = admit([connectionRow({ definition: { ...DEFINITION, ...extra } })]);
      expect([field, itemsOf(result)]).toEqual([field, [skipItem(ID, "DEFINITION_HAS_SECRET", { path: field })]]);
      expect(JSON.stringify(result.skipped)).not.toContain("example-only-secret-value");
    }

    // A credential is reported before any other fault of the definition, whatever the key order.
    const both = admit([connectionRow({ definition: { aaa: 1, ...DEFINITION, user: "reader", zzz: 2 } })]);
    expect(itemsOf(both)).toEqual([skipItem(ID, "DEFINITION_HAS_SECRET", { path: "user" })]);
    expect(opened).toEqual([]);
  });

  test("a postgres definition without database is skipped as SERVER_LEVEL_NOT_ALLOWED", () => {
    for (const definition of [
      { host: "db.example.internal", port: 5432 },
      { host: "db.example.internal", port: 5432, database: "" },
      { host: "db.example.internal", port: 5432, database: null },
    ]) {
      const result = admit([connectionRow({ definition })]);
      expect(result.admitted).toEqual([]);
      expect(itemsOf(result)).toEqual([skipItem(ID, "SERVER_LEVEL_NOT_ALLOWED", { path: "database" })]);
    }
    expect(opened).toEqual([]);

    // An engine whose provider opens no server-level sessions takes a definition without a database.
    const redis = admit([
      connectionRow({ engine: "redis", definition: { host: "cache.example.internal", port: 6379 } }),
    ]);
    expect(itemsOf(redis)).toEqual([]);
    expect(redis.admitted.map((connection) => connection.read.type)).toEqual(["redis"]);
  });

  test("sqlite is ENGINE_UNSUPPORTED and db2 outside the allowlist is ENGINE_NOT_ALLOWED", () => {
    const db2Definition = { host: "db2.example.internal", port: 50000, database: "ORDERS" };
    const rows = [
      connectionRow({ id: "file", engine: "sqlite", definition: { database: "/srv/orders.db" } }),
      connectionRow({ id: "db2", engine: "db2", definition: db2Definition }),
    ];
    expect(itemsOf(admit(rows))).toEqual([
      skipItem("file", "ENGINE_UNSUPPORTED"),
      skipItem("db2", "ENGINE_NOT_ALLOWED"),
    ]);
    expect(opened).toEqual([]);

    // A file engine stays unsupported when GOVERNANCE_ALLOWED_ENGINES names it; db2 is admitted once it is named.
    const named = admit(
      [
        ...rows,
        connectionRow({ id: "duck", engine: "duckdb", definition: { database: "/srv/orders.duckdb" } }),
        connectionRow({ id: "embedded", engine: "libredb", definition: { database: "/srv/orders.libredb" } }),
      ],
      { allowedEngines: [...OPTIONS.allowedEngines, "sqlite", "duckdb", "libredb", "db2"] },
    );
    expect(itemsOf(named)).toEqual([
      skipItem("file", "ENGINE_UNSUPPORTED"),
      skipItem("duck", "ENGINE_UNSUPPORTED"),
      skipItem("embedded", "ENGINE_UNSUPPORTED"),
    ]);
    expect(named.admitted.map((connection) => connection.id)).toEqual(["db2"]);

    // A name that is no Studio type id is unsupported too, and so is an engine column that is not text.
    const unknown = admit([
      connectionRow({ id: "typo", engine: "postgress" }),
      connectionRow({ columns: { engine: 5 } }),
    ]);
    expect(itemsOf(unknown)).toEqual([skipItem("typo", "ENGINE_UNSUPPORTED"), skipItem(ID, "ENGINE_UNSUPPORTED")]);
  });

  test("an unopenable write envelope keeps the row with read access and records WRITE_SECRET_UNOPENABLE", () => {
    // Sealed for the read level of the same row: moved to the write column, it fails AUTH_FAILED.
    const misplaced = sealSecret(KEY.publicKey, bindingOf(ID, "read"), WRITE);
    const result = admit([connectionRow({ columns: { write_secret: misplaced } })]);

    expect(result.admitted).toHaveLength(1);
    expect(result.admitted[0].read.user).toBe("reader");
    expect(result.admitted[0].write).toBeUndefined();
    // Only the envelope a record was opened from is kept.
    expect(Object.keys(result.admitted[0].envelopes)).toEqual(["read"]);
    expect(result.skipped).toEqual([
      { item: skipItem(ID, "WRITE_SECRET_UNOPENABLE", { level: "write" }), envelopeCode: "AUTH_FAILED" },
    ]);

    // A write column that holds no envelope at all is unopenable in the same way, as FORMAT.
    for (const writeSecret of ["", 7]) {
      const malformed = admit([connectionRow({ columns: { write_secret: writeSecret } })]);
      expect(malformed.admitted.map((connection) => connection.write)).toEqual([undefined]);
      expect(malformed.skipped).toEqual([
        { item: skipItem(ID, "WRITE_SECRET_UNOPENABLE", { level: "write" }), envelopeCode: "FORMAT" },
      ]);
    }
  });

  test("a read envelope that does not open skips the row as READ_SECRET_UNOPENABLE with its envelope code", () => {
    const stranger = testKey();
    const cases: readonly (readonly [unknown, EnvelopeCode])[] = [
      [sealSecret(stranger.publicKey, bindingOf(ID, "read"), READ), "UNKNOWN_KID"],
      [sealSecret(KEY.publicKey, bindingOf("another-connection", "read"), READ), "AUTH_FAILED"],
      [sealSecret(KEY.publicKey, bindingOf(ID, "write"), READ), "AUTH_FAILED"],
      [sealSecret(KEY.publicKey, bindingOf(ID, "read", "mysql"), READ), "AUTH_FAILED"],
      [
        sealSecret(KEY.publicKey, bindingOf(ID, "read", "postgres", { ...DEFINITION, host: "other" }), READ),
        "AUTH_FAILED",
      ],
      [sealSecret(KEY.publicKey, bindingOf(ID, "read"), { user: "reader", token: "x" }), "PLAINTEXT_INVALID"],
      [UNOPENED, "FORMAT"],
      [null, "FORMAT"],
    ];
    for (const [readSecret, envelopeCode] of cases) {
      opened.length = 0;
      const result = admit([connectionRow({ write: WRITE, columns: { read_secret: readSecret } })]);
      expect(result.admitted).toEqual([]);
      expect(result.skipped).toEqual([
        { item: skipItem(ID, "READ_SECRET_UNOPENABLE", { level: "read" }), envelopeCode },
      ]);
      // The write envelope of a row that is skipped is never opened.
      expect(opened.filter((binding) => binding.level === "write")).toEqual([]);
    }
  });

  test("a ${DB_PASSWORD} password stays literal text on the admitted record", () => {
    const saved = process.env.DB_PASSWORD;
    process.env.DB_PASSWORD = "example-only-environment-password";
    try {
      const definition = { host: "${DB_HOST}", port: 5432, database: "${vault:secret/data/orders#database}" };
      const result = admit([connectionRow({ definition, read: { user: "reader", password: "${DB_PASSWORD}" } })]);

      expect(itemsOf(result)).toEqual([]);
      const { read } = result.admitted[0];
      expect(read.password).toBe("${DB_PASSWORD}");
      expect(read.host).toBe("${DB_HOST}");
      expect(read.database).toBe("${vault:secret/data/orders#database}");
      // The marker resolveConnection reads to hand a connection back with its values as written.
      expect(read.literal).toBe(true);
      expect(JSON.stringify(read)).not.toContain("example-only-environment-password");
    } finally {
      if (saved === undefined) delete process.env.DB_PASSWORD;
      else process.env.DB_PASSWORD = saved;
    }
  });

  test("sslClientKey and sslClientCert land in ssl.clientKey and ssl.clientCert", () => {
    const definition = { ...DEFINITION, ssl: { mode: "verify-full", caCert: "ca-certificate-text" } };
    const tls = { sslClientKey: "client-key-text", sslClientCert: "client-certificate-text" };
    const result = admit([
      connectionRow({ definition, read: { ...READ, ...tls }, write: { ...WRITE, sslClientCert: "write-cert-text" } }),
    ]);

    expect(itemsOf(result)).toEqual([]);
    const { read, write } = result.admitted[0];
    expect(read.ssl).toEqual({
      mode: "verify-full",
      caCert: "ca-certificate-text",
      clientKey: "client-key-text",
      clientCert: "client-certificate-text",
    });
    expect(read).not.toHaveProperty("sslClientKey");
    expect(read).not.toHaveProperty("sslClientCert");
    // Each level's envelope is a complete credential set: the write record carries only what its own envelope holds.
    expect(write?.ssl).toEqual({ mode: "verify-full", caCert: "ca-certificate-text", clientCert: "write-cert-text" });

    // Without TLS fields in the definition, the credential's client key and certificate still make an ssl object.
    const bare = admit([connectionRow({ read: { ...READ, ...tls } })]);
    // SSLConfig types mode as required, which the seed schema leaves optional, so the record is compared untyped.
    expect(bare.admitted[0].read.ssl as unknown).toEqual({
      clientKey: "client-key-text",
      clientCert: "client-certificate-text",
    });
    // And a credential without them leaves the definition's ssl object as it is.
    const plain = admit([connectionRow({ definition })]);
    expect(plain.admitted[0].read.ssl).toEqual({ mode: "verify-full", caCert: "ca-certificate-text" });
  });

  test("a row whose environment, group_name and color are NULL is admitted without those fields", () => {
    const result = admit([connectionRow({ columns: { environment: null, group_name: null, color: null } })]);

    expect(itemsOf(result)).toEqual([]);
    const { read } = result.admitted[0];
    expect(read.environment).toBeUndefined();
    expect(read.group).toBeUndefined();
    expect(read.color).toBeUndefined();
    expect(Object.values(read)).not.toContain(null);
  });

  test("admission accepts exactly the keys and value domains of the manifest's definition allowlist and skips anything else as DEFINITION_INVALID", () => {
    // MySQL, whose provider opens no server-level session, so every probe of `database` is judged by its domain alone.
    const base = { host: "db.example.internal", database: "orders" };
    const probes: readonly unknown[] = [
      null,
      true,
      false,
      0,
      1,
      65535,
      65536,
      -1,
      1.5,
      "",
      "x",
      "5432",
      "prefer",
      {},
      [],
    ];
    for (const { path: field, domain } of MANIFEST.definitionAllowlist) {
      const inDomain = z.fromJSONSchema(domain);
      for (const probe of [...probes, ...(Array.isArray(domain.enum) ? domain.enum : [])]) {
        opened.length = 0;
        const definition = withField(base, field, probe);
        if (inDomain.safeParse(probe).success) {
          const result = admit([connectionRow({ engine: "mysql", definition })]);
          expect([field, probe, itemsOf(result)]).toEqual([field, probe, []]);
          expect([field, probe, valueAt(result.admitted[0].read, field)]).toEqual([field, probe, probe]);
        } else {
          const result = admit([connectionRow({ engine: "mysql", definition, columns: { read_secret: UNOPENED } })]);
          expect([field, probe, itemsOf(result)]).toEqual([
            field,
            probe,
            [skipItem(ID, "DEFINITION_INVALID", { path: field })],
          ]);
          expect(opened).toEqual([]);
        }
      }
    }

    // Every key of the allowlist at once.
    const full = {
      host: "db.example.internal",
      port: 3306,
      database: "orders",
      schema: "sales",
      serviceName: "ORCL",
      instanceName: "SQLEXPRESS",
      authSource: "admin",
      skipObjectScan: true,
      ssl: { mode: "verify-full", rejectUnauthorized: true, caCert: "ca-certificate-text" },
    };
    expect(MANIFEST.definitionAllowlist.map((entry) => valueAt(full, entry.path) !== undefined)).not.toContain(false);
    const all = admit([connectionRow({ engine: "mysql", definition: full })]);
    expect(itemsOf(all)).toEqual([]);
    expect(all.admitted[0].read).toMatchObject(full);
    // An empty ssl object holds no key outside the allowlist.
    expect(itemsOf(admit([connectionRow({ definition: { ...DEFINITION, ssl: {} } })]))).toEqual([]);

    // Any other key, at the top or inside ssl, is DEFINITION_INVALID at its path.
    opened.length = 0;
    const others: readonly (readonly [string, unknown])[] = [
      ["ssl.clientCert", "client-certificate-text"],
      ["queryTimeout", 60000],
      ["readOnly", true],
      ["localDataCenter", "datacenter1"],
      ["sslmode", "require"],
      ["ssl.verify", true],
      ["ssl", "require"],
      ["options", { statement_timeout: 0 }],
    ];
    for (const [field, value] of others) {
      const result = admit([connectionRow({ definition: withField(DEFINITION, field, value) })]);
      expect([field, itemsOf(result)]).toEqual([field, [skipItem(ID, "DEFINITION_INVALID", { path: field })]]);
    }
    // A top-level key that holds a dot is one key outside the allowlist, never the mode of the ssl object.
    const dotted = admit([connectionRow({ definition: { ...DEFINITION, "ssl.mode": "verify-full" } })]);
    expect(itemsOf(dotted)).toEqual([skipItem(ID, "DEFINITION_INVALID", { path: "ssl.mode" })]);
    expect(opened).toEqual([]);
  });

  test("a malformed id is DEFINITION_INVALID, and every row of a duplicated id is skipped at path connection_id", () => {
    const longest = "a".repeat(64);
    const rows = [
      connectionRow({ id: "orders" }),
      connectionRow({ id: "Orders_DB" }),
      connectionRow({ id: "a".repeat(65) }),
      connectionRow({ id: longest }),
      connectionRow({ id: "twice" }),
      connectionRow({ id: "kept" }),
      connectionRow({ id: "twice" }),
      connectionRow({ columns: { connection_id: "" } }),
      connectionRow({ columns: { connection_id: null } }),
      connectionRow({ columns: { connection_id: undefined } }),
    ];
    const result = admit(rows);

    expect(result.admitted.map((connection) => connection.id)).toEqual(["orders", longest, "kept"]);
    const atId = (id: string) => skipItem(id, "DEFINITION_INVALID", { path: "connection_id" });
    // A malformed id is named as the governance source wrote it, or by its JSON text when that is not a non-empty
    // string, so the item still names something to look for.
    expect(itemsOf(result)).toEqual([
      atId("Orders_DB"),
      atId("a".repeat(65)),
      atId("twice"),
      atId("twice"),
      atId('""'),
      atId("null"),
      atId("undefined"),
    ]);
    // Neither row of a repeated id is opened: Studio cannot tell which one the control plane meant.
    expect(opened.map((binding) => binding.connectionId)).toEqual(["orders", longest, "kept"]);
  });

  test("a definition that is not a JSON object is DEFINITION_INVALID at path definition", () => {
    for (const definition of [null, [], ["host"], "host=db.example.internal", 5432]) {
      const result = admit([connectionRow({ columns: { definition } })]);
      expect([definition, itemsOf(result)]).toEqual([
        definition,
        [skipItem(ID, "DEFINITION_INVALID", { path: "definition" })],
      ]);
    }
    expect(opened).toEqual([]);
  });

  test("a merged record that Studio's seed validation refuses is DEFINITION_INVALID at the first issue's path and level", () => {
    // The read credential of a PostgreSQL row carries the Elasticsearch-only API key pair: the row is skipped.
    const apiKey = admit([connectionRow({ read: { ...READ, apiKeyId: "example-only-key-id" } })]);
    expect(apiKey.admitted).toEqual([]);
    expect(itemsOf(apiKey)).toEqual([skipItem(ID, "DEFINITION_INVALID", { level: "read", path: "apiKeyId" })]);

    // The write credential of a SQL Server row carries a connection string its provider never reads: the row is kept
    // with read access only.
    const mssqlDefinition = { host: "mssql.example.internal", port: 1433, database: "orders" };
    const mssql = admit([
      connectionRow({
        engine: "mssql",
        definition: mssqlDefinition,
        write: { connectionString: "Server=mssql.example.internal;Password=example-only-in-string" },
      }),
    ]);
    expect(mssql.admitted.map((connection) => [connection.read.user, connection.write])).toEqual([
      ["reader", undefined],
    ]);
    expect(itemsOf(mssql)).toEqual([skipItem(ID, "DEFINITION_INVALID", { level: "write", path: "connectionString" })]);
    expect(JSON.stringify(mssql.skipped)).not.toContain("example-only-in-string");

    // The row's own columns are validated with the read record, the first refused field named.
    const columns: readonly (readonly [Readonly<Record<string, unknown>>, string])[] = [
      [{ name: "n".repeat(129) }, "name"],
      [{ name: 42 }, "name"],
      [{ environment: "prod" }, "environment"],
      [{ environment: "prod", color: "red" }, "environment"],
      [{ group_name: "g".repeat(65) }, "group"],
      [{ color: "red" }, "color"],
      [{ mcp_enabled: null }, "mcp"],
    ];
    for (const [overrides, field] of columns) {
      const result = admit([connectionRow({ columns: overrides })]);
      expect([overrides, itemsOf(result)]).toEqual([
        overrides,
        [skipItem(ID, "DEFINITION_INVALID", { level: "read", path: field })],
      ]);
    }

    // A credential key outside the lsb1 plaintext keys (docs/GOVERNANCE.md#sealed-credentials-lsb1), which only an
    // opener that broke its own contract could hand over, is named.
    const loose = admit([connectionRow()], { openSecret: () => ({ ...READ, sessionToken: "x" }) as OpenedSecret });
    expect(itemsOf(loose)).toEqual([skipItem(ID, "DEFINITION_INVALID", { level: "read", path: "sessionToken" })]);
  });

  test("mcp follows mcp_enabled only where MCP_EXPOSABLE offers the engine", () => {
    const offered = admit([connectionRow({ write: WRITE, columns: { mcp_enabled: true } })]);
    expect(offered.admitted.map((connection) => [connection.read.mcp, connection.write?.mcp])).toEqual([[true, true]]);

    // MCP is not offered for etcd, so its flag is left off rather than refused, and the row is served.
    const etcd = admit(
      [
        connectionRow({
          engine: "etcd",
          definition: { host: "etcd.example.internal", port: 2379 },
          columns: { mcp_enabled: true },
        }),
      ],
      { allowedEngines: ["etcd"] },
    );
    expect(itemsOf(etcd)).toEqual([]);
    expect(etcd.admitted[0].read.mcp).toBeUndefined();
  });

  test("an opener failure that carries no envelope code is no row's fault, so admission throws it", () => {
    const missingKeyring = new Error("GOVERNANCE_PRIVATE_KEYS_FILE is not set");
    const openSecret = () => {
      throw missingKeyring;
    };
    expect(() => admit([connectionRow()], { openSecret })).toThrow(missingKeyring);
  });

  test("openGovernedSecret, the opener the snapshot loader passes, admits a row sealed to the keyring file", () => {
    const savedFile = process.env.GOVERNANCE_PRIVATE_KEYS_FILE;
    // The keyring logs its kids when it loads; nothing here is about that line.
    const quiet = spyOn(console, "info").mockImplementation(() => {});
    try {
      process.env.GOVERNANCE_PRIVATE_KEYS_FILE = keyringFileOf(KEY);
      resetGovernanceKeyring();
      const result = admitConnectionRows([connectionRow({ write: WRITE })], {
        allowedEngines: OPTIONS.allowedEngines,
        openSecret: openGovernedSecret,
      });
      expect(itemsOf(result)).toEqual([]);
      expect(result.admitted.map((connection) => [connection.read.user, connection.write?.user])).toEqual([
        ["reader", "writer"],
      ]);
    } finally {
      quiet.mockRestore();
      if (savedFile === undefined) delete process.env.GOVERNANCE_PRIVATE_KEYS_FILE;
      else process.env.GOVERNANCE_PRIVATE_KEYS_FILE = savedFile;
      resetGovernanceKeyring();
    }
  });

  test("every skip entry validates against the manifest's skipped shape and carries no value", () => {
    const definition = { host: "host-value.example.internal", port: 5432, database: "database-value" };
    const leaked = "example-only-leaked-value";
    const rows = [
      connectionRow({ id: "Bad_Id", definition }),
      connectionRow({ id: "twice", definition }),
      connectionRow({ id: "twice", definition }),
      connectionRow({ id: "file", engine: "sqlite", definition: { database: "/srv/file-value.db" } }),
      connectionRow({ id: "db2", engine: "db2", definition }),
      connectionRow({ id: "server", definition: { host: "host-value.example.internal", port: 5432 } }),
      connectionRow({ id: "leak", definition: { ...definition, password: leaked } }),
      connectionRow({ id: "timeout", definition: { ...definition, queryTimeout: 60000 } }),
      connectionRow({
        id: "stranger",
        definition,
        columns: {
          read_secret: sealSecret(testKey().publicKey, bindingOf("stranger", "read", "postgres", definition), READ),
        },
      }),
      connectionRow({
        id: "moved",
        definition,
        columns: {
          write_secret: sealSecret(KEY.publicKey, bindingOf("elsewhere", "write", "postgres", definition), WRITE),
        },
      }),
      connectionRow({ id: "api-key", definition, read: { ...READ, apiKeyId: leaked } }),
      connectionRow({ id: "kept", definition, write: WRITE }),
    ];
    const result = admit(rows);
    const items = itemsOf(result);

    expect(result.admitted.map((connection) => connection.id)).toEqual(["moved", "kept"]);
    expect(SKIPPED_SHAPE.safeParse(items).success).toBe(true);
    for (const item of items) expect(SkippedItemSchema.safeParse(item).success).toBe(true);
    // Every skip code of docs/GOVERNANCE.md#row-admission-and-skip-codes but SETTING_INVALID, which settings produce,
    // comes out of a connection row.
    expect([...new Set(items.map((item) => item.code))].sort()).toEqual(
      SKIP_CODES.filter((code) => code !== "SETTING_INVALID").sort(),
    );

    const text = JSON.stringify(result.skipped);
    const values = [
      leaked,
      READ.password,
      WRITE.password,
      "host-value",
      "database-value",
      "file-value",
      "Orders",
      "Sales",
      "#1f6feb",
      "60000",
      ...rows.flatMap((row) => [row.read_secret, row.write_secret]).filter((secret) => typeof secret === "string"),
    ];
    for (const value of values) expect([value, text.includes(value as string)]).toEqual([value, false]);
  });
});

/** A copy of `definition` with `value` at the dotted `field`, creating the nested object it needs. */
function withField(
  definition: Readonly<Record<string, unknown>>,
  field: string,
  value: unknown,
): Readonly<Record<string, unknown>> {
  const [head, ...rest] = field.split(".");
  if (rest.length === 0) return { ...definition, [head]: value };
  const inner = definition[head];
  const nested = typeof inner === "object" && inner !== null ? (inner as Readonly<Record<string, unknown>>) : {};
  return { ...definition, [head]: withField(nested, rest.join("."), value) };
}

/** The value at the dotted `field` of `record`. */
function valueAt(record: unknown, field: string): unknown {
  return field
    .split(".")
    .reduce<unknown>((value, key) => (value as Readonly<Record<string, unknown>> | undefined)?.[key], record);
}
