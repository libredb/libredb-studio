/**
 * Every provider is built from only the fields its engine declares (FND-2 slice 6, docs/SECURITY.md control 3.41).
 *
 * `providerFields` (src/lib/db/provider-connection.ts) composes, from the contract rows, the fields a provider of each
 * type receives, and `createDatabaseProvider` builds every provider from a copy of the connection holding those fields
 * and core's markers. This census builds every shipped type-id through the real `createDatabaseProvider`, the function
 * an embedder of `@libredb/studio/providers` calls, from a record that carries a generated marker in every
 * `DatabaseConnection` field its engine does not receive (the agent credential among them) and in a symbol key of the
 * caller's own, and walks the whole provider for the markers. Nothing connects in the first describe: each build is a
 * dynamic import and a constructor (`tests/helpers/census-connection.ts`).
 *
 * The second describe holds that a connection that sets a field its engine refuses (`REFUSED_CONNECTION_FIELDS`) is
 * refused by `createDatabaseProvider` with the declared sentence, which names the field, before any provider is built.
 *
 * The third holds that a connection whose engine declares a required secret (a `fieldRules` entry with `required` on a
 * field the storage classification calls secret) is refused by `createDatabaseProvider` with the declared sentence
 * when that secret is blank, before any provider is built, while `readProviderDeclarations` still reads it.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { REFUSED_CONNECTION_FIELDS, type ConnectionField } from "@/lib/db/connection-fields";
import { CONNECTION_FORM } from "@/lib/db/connection-form";
import { DatabaseConfigError } from "@/lib/db/errors";
import { createDatabaseProvider, readProviderDeclarations } from "@/lib/db/factory";
import { providerFields } from "@/lib/db/provider-connection";
import type { DatabaseConnection, DatabaseProvider } from "@/lib/db/types";
import { databaseErrorBody } from "@/lib/api/error-body";
import { CONNECTION_FIELDS as FIELD_CLASS } from "@/lib/storage/secret-fields";
import {
  ADMITTED_FILE,
  ADMITTED_HOST_PATHS,
  LITERAL_SEED_FILE,
  TUNNEL_FAR_END,
  TUNNEL_ROUTE,
  type DatabaseType,
} from "@/lib/types";
import { CENSUS_CONNECTION } from "../helpers/census-connection";
import { markersReachableFrom } from "../helpers/reachable-markers";

const CORE_MARKERS: readonly symbol[] = [
  TUNNEL_ROUTE,
  TUNNEL_FAR_END,
  LITERAL_SEED_FILE,
  ADMITTED_FILE,
  ADMITTED_HOST_PATHS,
];

/** The members of the `DatabaseConnection` interface, read from src/lib/types.ts, so a new field is planted at once. */
function connectionFields(): string[] {
  const path = join(import.meta.dir, "..", "..", "src", "lib", "types.ts");
  const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const declaration = file.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === "DatabaseConnection",
  );
  if (declaration === undefined) throw new Error("src/lib/types.ts declares no DatabaseConnection interface");
  return declaration.members.flatMap((member) =>
    member.name !== undefined && ts.isIdentifier(member.name) ? [member.name.text] : [],
  );
}

const FIELDS = connectionFields();

/**
 * The fields a record of `type` carries a marker in: every connection field its engine does not receive, except
 * `sshTunnel`, which core reads before any build and refuses unless it is a plain object
 * (tests/security/provider-tunnel-secrets.test.ts holds that no provider receives it), and the fields its engine
 * refuses by name, which core refuses before any build (the second describe below).
 */
function plantedFields(type: DatabaseType): string[] {
  const received: readonly string[] = providerFields(type);
  const refused: readonly string[] = Object.keys(REFUSED_CONNECTION_FIELDS[type]);
  return FIELDS.filter((field) => field !== "sshTunnel" && !received.includes(field) && !refused.includes(field));
}

interface Planted {
  readonly record: DatabaseConnection;
  readonly markers: string[];
  readonly embedderKey: symbol;
}

/** The census record of `type`, a generated marker in every field it does not receive and in four symbol keys. */
function plantedRecord(type: DatabaseType): Planted {
  const run = crypto.randomUUID();
  const markers: string[] = [];
  const mark = (where: string): string => {
    const marker = `${where}-${run}`;
    markers.push(marker);
    return marker;
  };
  const record: Record<string | symbol, unknown> = { ...CENSUS_CONNECTION[type] };
  for (const field of plantedFields(type)) record[field] = mark(field);
  const embedderKey = Symbol("embedder");
  record[embedderKey] = mark("embedder");
  record[TUNNEL_ROUTE] = mark("route");
  record[ADMITTED_FILE] = `/${mark("admitted-file")}`;
  record[ADMITTED_HOST_PATHS] = { clientCertificatePath: `/${mark("admitted-host-path")}` };
  record[LITERAL_SEED_FILE] = true;
  return { record: record as unknown as DatabaseConnection, markers, embedderKey };
}

/** A record that is not plain data, with no tunnel, each a shape a copy would read differently. */
function notPlainRecords(): ReadonlyArray<[string, DatabaseConnection]> {
  class Connection {
    id = "plain";
    name = "plain";
    type = "etcd" as const;
    host = "127.0.0.1";
    port = 1;
    createdAt = new Date(0);
  }
  const inherited = Object.assign(Object.create({ readOnly: true }) as object, CENSUS_CONNECTION.etcd);
  const accessor: DatabaseConnection = { ...CENSUS_CONNECTION.etcd };
  Object.defineProperty(accessor, "readOnly", { get: () => true, enumerable: true });
  const hidden: DatabaseConnection = { ...CENSUS_CONNECTION.etcd };
  Object.defineProperty(hidden, "readOnly", { value: true, enumerable: false });
  return [
    ["a class instance", new Connection() as unknown as DatabaseConnection],
    ["a record whose readOnly is inherited", inherited as DatabaseConnection],
    ["a record whose readOnly is an accessor", accessor],
    ["a record whose readOnly is not enumerable", hidden],
  ];
}

describe("every provider is built from only the fields its engine declares (FND-2 slice 6)", () => {
  test("the census plants a marker in the agent credential and in Studio's own display fields", () => {
    for (const type of SHIPPED_DATABASE_TYPES) {
      const planted = plantedFields(type);
      for (const field of [
        "agentUser",
        "agentPassword",
        "createdAt",
        "color",
        "environment",
        "group",
        "skipObjectScan",
      ]) {
        expect({ type, field, planted: planted.includes(field) }).toEqual({ type, field, planted: true });
      }
    }
  });

  test.each([...SHIPPED_DATABASE_TYPES])(
    "%s holds no field its engine does not declare and no symbol key but core's markers",
    async (type) => {
      const { record, markers, embedderKey } = plantedRecord(type);
      const provider = await createDatabaseProvider(record);
      expect(markersReachableFrom(provider, markers)).toEqual([]);
      expect(provider.config).not.toBe(record);
      const received: readonly string[] = providerFields(type);
      expect(Object.keys(provider.config).filter((key) => !received.includes(key))).toEqual([]);
      const symbols = Object.getOwnPropertySymbols(provider.config);
      expect(symbols.filter((key) => !CORE_MARKERS.includes(key))).toEqual([]);
      expect(symbols).not.toContain(embedderKey);
      expect(Reflect.get(provider.config, LITERAL_SEED_FILE)).toBe(true);
    },
  );

  test.each([...SHIPPED_DATABASE_TYPES])(
    "%s holds every received field the record sets, as the record holds it, and no received field it leaves absent",
    async (type) => {
      const record: DatabaseConnection = { ...CENSUS_CONNECTION[type], ssl: { mode: "require" } };
      const provider = await createDatabaseProvider(record);
      const config = provider.config as unknown as Record<string, unknown>;
      const given = record as unknown as Record<string, unknown>;
      for (const field of providerFields(type)) {
        if (Object.hasOwn(record, field))
          expect({ field, value: config[field] }).toEqual({ field, value: given[field] });
        else expect({ field, own: Object.hasOwn(config, field) }).toEqual({ field, own: false });
      }
      if (providerFields(type).includes("ssl")) expect(provider.config.ssl).toBe(record.ssl);
      expect(Object.hasOwn(config, "queryTimeout")).toBe(false);
    },
  );

  test.each([...SHIPPED_DATABASE_TYPES])("%s leaves the record the caller passed unchanged", async (type) => {
    const { record } = plantedRecord(type);
    // The string-keyed fields compared as data, the symbol keys by identity of key and value.
    const fieldsOf = (value: DatabaseConnection): Record<string, unknown> => Object.fromEntries(Object.entries(value));
    const before = structuredClone(fieldsOf(record));
    const symbolsBefore = Object.getOwnPropertySymbols(record).map((key) => [key, Reflect.get(record, key)]);
    await createDatabaseProvider(record);
    expect(fieldsOf(record)).toEqual(before);
    expect(Object.getOwnPropertySymbols(record).map((key) => [key, Reflect.get(record, key)])).toEqual(symbolsBefore);
  });

  test.each(notPlainRecords())(
    "%s without a tunnel is refused by name, and nothing is built",
    async (_shape, record) => {
      const refusal: unknown = await createDatabaseProvider(record).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(DatabaseConfigError);
      expect((refusal as Error).message).toBe(
        "A connection must be a plain object of data fields; no provider was built.",
      );
    },
  );
});

/**
 * Each refused (type, field) with the sentence it is refused with: the words the engine's provider said before core
 * took the refusal over (FND-2 slice 6c), which each engine's provider doc quotes.
 */
const OPENSEARCH_API_KEY =
  "OpenSearch does not accept API key authentication. Elasticsearch publishes Authorization: ApiKey; nothing here has measured whether OpenSearch's security plugin accepts that scheme, so the pair is refused rather than sent as Basic or as a guessed header.";
const REFUSED_SENTENCES: readonly (readonly [DatabaseType, ConnectionField, string])[] = [
  ["opensearch", "apiKeyId", OPENSEARCH_API_KEY],
  ["opensearch", "apiKeySecret", OPENSEARCH_API_KEY],
  [
    "qdrant",
    "user",
    "Qdrant has no user name: clear the connection's user, and put the API key or JWT in the password. Nothing was sent.",
  ],
  [
    "weaviate",
    "user",
    "Weaviate takes no user name: clear the connection's user, and put the API key or OIDC access token in the password. Nothing was sent.",
  ],
  ["influxdb3", "user", "InfluxDB 3 has no user name: clear User and put the token in Token."],
  ["oxia", "user", "Oxia has no user name: clear User. A bearer token goes under Token."],
  [
    "spark",
    "user",
    "Apache Spark connections take no user: every Studio request uses one fixed Spark Connect user id, and Token is the credential. Clear User. Nothing was sent.",
  ],
  [
    "kubernetes",
    "user",
    "Kubernetes connections take no user name: basic authentication is refused. Clear User, and put a bearer token under Token or a client certificate under SSL / TLS. Nothing was sent.",
  ],
  [
    "rabbitmq",
    "database",
    "RabbitMQ connections take no Database: Studio discovers the virtual hosts from the management API. Clear the field; nothing was sent.",
  ],
  [
    "rabbitmq",
    "namespaces",
    "RabbitMQ connections take no Namespaces: Studio discovers the virtual hosts from the management API. Clear the field; nothing was sent.",
  ],
  [
    "rabbitmq",
    "tlsServerName",
    "RabbitMQ connections take no TLS server name: the certificate is always checked against Host. Clear the field; nothing was sent.",
  ],
];

/** The census record of `type` with `field` set to `value`, or without it when `value` is undefined. */
function refusedRecord(type: DatabaseType, field: string, value: unknown): DatabaseConnection {
  const record: Record<string, unknown> = { ...CENSUS_CONNECTION[type] };
  delete record[field];
  if (value !== undefined) record[field] = value;
  return record as unknown as DatabaseConnection;
}

/** What `createDatabaseProvider` answers for `record`: the provider, or the error it rejects with. */
async function buildOutcome(record: DatabaseConnection): Promise<unknown> {
  return await createDatabaseProvider(record).then(
    (provider) => provider,
    (caught: unknown) => caught,
  );
}

describe("a field its engine refuses is refused by core, by name, before the provider is built (FND-2 slice 6c)", () => {
  test("the entries are the eleven the row declares, each with the sentence its engine said", () => {
    const declared = SHIPPED_DATABASE_TYPES.flatMap((type) =>
      Object.entries(REFUSED_CONNECTION_FIELDS[type]).map(([field, sentence]) => [type, field, sentence]),
    );
    const key = (entry: readonly unknown[]): string => `${String(entry[0])}.${String(entry[1])}`;
    const byKey = (entries: readonly (readonly unknown[])[]) =>
      [...entries].sort((left, right) => key(left).localeCompare(key(right))).map((entry) => entry.slice());
    expect(declared.length).toBe(11);
    expect(byKey(declared)).toEqual(byKey(REFUSED_SENTENCES));
  });

  test.each(REFUSED_SENTENCES)(
    "%s: a connection that sets %s is refused before the provider is built, answering not-sent",
    async (type, field, sentence) => {
      const value = `refused-${crypto.randomUUID()}`;
      const log = spyOn(console, "log").mockImplementation(() => {});
      try {
        const error = await buildOutcome(refusedRecord(type, field, value));
        expect(error).toBeInstanceOf(DatabaseConfigError);
        expect((error as DatabaseConfigError).message).toBe(sentence);
        expect((error as DatabaseConfigError).provider).toBe(type);
        expect((error as DatabaseConfigError).message).not.toContain(value);
        expect(databaseErrorBody(error)?.body.outcome).toBe("not-sent");
        expect(log.mock.calls.some(([line]) => String(line).startsWith(`[DB] Creating ${type} provider`))).toBe(false);
      } finally {
        log.mockRestore();
      }
    },
  );

  test.each(REFUSED_SENTENCES)(
    "%s: %s counts as set whatever its value, and as absent when undefined, null or empty",
    async (type, field, sentence) => {
      const set = await Promise.all(
        [" ", 42, {}, false].map((value) => buildOutcome(refusedRecord(type, field, value))),
      );
      for (const error of set) {
        expect(error).toBeInstanceOf(DatabaseConfigError);
        expect((error as DatabaseConfigError).message).toBe(sentence);
      }
      const absent = await Promise.all(
        [undefined, null, ""].map((value) => buildOutcome(refusedRecord(type, field, value))),
      );
      for (const provider of absent) {
        expect(provider).not.toBeInstanceOf(Error);
        expect(Object.hasOwn((provider as DatabaseProvider).config, field)).toBe(false);
      }
    },
  );
});

interface RequiredSecret {
  readonly type: DatabaseType;
  readonly field: ConnectionField;
  readonly sentence: string;
  /** The field and value that show it, when a `fieldShownWhen` condition does. */
  readonly shownWhen?: { readonly field: ConnectionField; readonly equals: string };
  /** Whether that value is the controlling field's declared default, so a record without the field shows it too. */
  readonly byDefault: boolean;
}

/** Every declared required secret of every form entry, with the condition that shows it. */
const REQUIRED_SECRETS: readonly RequiredSecret[] = Object.entries(CONNECTION_FORM).flatMap(([type, config]) =>
  config.connectionFields.flatMap((field) => {
    const sentence = config.fieldRules?.[field]?.required;
    if (sentence === undefined || FIELD_CLASS[field] !== "secret") return [];
    const shownWhen = config.fieldShownWhen?.[field];
    const byDefault = shownWhen !== undefined && config.fieldDefaults?.[shownWhen.field] === shownWhen.equals;
    return [{ type: type as DatabaseType, field, sentence, shownWhen, byDefault }];
  }),
);

/** The blank forms of a secret: absent, empty, only whitespace and not text. */
const BLANKS: readonly (readonly [string, unknown])[] = [
  ["absent", undefined],
  ["empty", ""],
  ["whitespace", " \n\t "],
  ["null", null],
];

/** The census record of the secret's type, its controlling field set (or removed) and the secret set to `value`. */
function secretRecord(secret: RequiredSecret, value: unknown, selector: "set" | "absent"): DatabaseConnection {
  const record: Record<string, unknown> = { ...CENSUS_CONNECTION[secret.type] };
  if (secret.shownWhen !== undefined) {
    if (selector === "set") record[secret.shownWhen.field] = secret.shownWhen.equals;
    else delete record[secret.shownWhen.field];
  }
  delete record[secret.field];
  if (value !== undefined) record[secret.field] = value;
  return record as unknown as DatabaseConnection;
}

const SECRET_CASES = REQUIRED_SECRETS.flatMap((secret) =>
  (secret.byDefault ? (["set", "absent"] as const) : (["set"] as const)).flatMap((selector) =>
    BLANKS.map(([form, value]) => [`${secret.type}.${secret.field}`, form, selector, secret, value] as const),
  ),
);

describe("a connection whose declared required secret is blank is refused by name before the provider is built (FND-2 slice 6b)", () => {
  test("the declared required secrets are Snowflake's key under Key pair and its token under a programmatic access token", () => {
    expect(
      REQUIRED_SECRETS.map(({ type, field, shownWhen, byDefault }) => ({ type, field, shownWhen, byDefault })),
    ).toEqual([
      {
        type: "snowflake",
        field: "privateKey",
        shownWhen: { field: "authMethod", equals: "keypair" },
        byDefault: true,
      },
      { type: "snowflake", field: "password", shownWhen: { field: "authMethod", equals: "pat" }, byDefault: false },
    ]);
  });

  test.each(SECRET_CASES)(
    "%s %s, its selector %s: createDatabaseProvider refuses it with the declared sentence, readProviderDeclarations reads it",
    async (_name, _form, selector, secret, value) => {
      const record = secretRecord(secret, value, selector);
      const before = structuredClone(record);
      const error: unknown = await createDatabaseProvider(record).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(DatabaseConfigError);
      expect((error as DatabaseConfigError).message).toBe(secret.sentence);
      expect((error as DatabaseConfigError).provider).toBe(secret.type);
      expect(record).toEqual(before);
      const declarations = await readProviderDeclarations(record);
      expect(declarations.capabilities).toBeDefined();
      expect(declarations.labels).toBeDefined();
    },
  );

  test.each(REQUIRED_SECRETS.map((secret) => [`${secret.type}.${secret.field}`, secret] as const))(
    "%s holding a generated secret builds an unconnected provider",
    async (_name, secret) => {
      const provider = await createDatabaseProvider(secretRecord(secret, crypto.randomUUID(), "set"));
      expect(provider.isConnected()).toBe(false);
    },
  );
});
