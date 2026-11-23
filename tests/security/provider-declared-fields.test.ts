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
 * The second describe holds that a field an engine receives only to refuse it (`REFUSED_CONNECTION_FIELDS`) is still
 * refused by name through the factory, at connect and before any socket, against 127.0.0.1 port 1.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { REFUSED_CONNECTION_FIELDS } from "@/lib/db/connection-fields";
import { DatabaseConfigError } from "@/lib/db/errors";
import { createDatabaseProvider } from "@/lib/db/factory";
import { providerFields } from "@/lib/db/provider-connection";
import type { DatabaseConnection } from "@/lib/db/types";
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
 * (tests/security/provider-tunnel-secrets.test.ts holds that no provider receives it).
 */
function plantedFields(type: DatabaseType): string[] {
  const received: readonly string[] = providerFields(type);
  return FIELDS.filter((field) => field !== "sshTunnel" && !received.includes(field));
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

/** The words each refusal names its field with, as the provider's own sentence spells it. */
const REFUSAL_NAMES: Readonly<Record<string, RegExp>> = Object.freeze({
  user: /\buser\b/i,
  database: /\bDatabase\b/,
  namespaces: /\bNamespaces\b/,
  tlsServerName: /\bTLS server name\b/,
  apiKeyId: /\bAPI key\b/,
  apiKeySecret: /\bAPI key\b/,
});

const REFUSED_ENTRIES = SHIPPED_DATABASE_TYPES.flatMap((type) =>
  REFUSED_CONNECTION_FIELDS[type].map((field) => [type, field] as const),
);

/** The error `connect()` answers for the census record of `type` with `field` set to `value`, or absent when undefined. */
async function connectError(type: DatabaseType, field: string, value: string | undefined): Promise<unknown> {
  const record: Record<string, unknown> = { ...CENSUS_CONNECTION[type] };
  delete record[field];
  if (value !== undefined) record[field] = value;
  const provider = await createDatabaseProvider(record as unknown as DatabaseConnection);
  const error: unknown = await provider.connect().then(
    () => undefined,
    (caught: unknown) => caught,
  );
  await provider.disconnect().catch(() => undefined);
  return error;
}

describe("a field an engine receives only to refuse it is still refused by name through the factory", () => {
  test("the entries are the ones the row declares, and each has the words its refusal names it with", () => {
    expect(REFUSED_ENTRIES.length).toBe(11);
    for (const [, field] of REFUSED_ENTRIES) expect(Object.hasOwn(REFUSAL_NAMES, field)).toBe(true);
  });

  test.each(REFUSED_ENTRIES)(
    "%s refuses %s by name at connect, and a record without it is not refused for it",
    async (type, field) => {
      const refusal = await connectError(type, field, `refused-${crypto.randomUUID()}`);
      expect(refusal).toBeInstanceOf(DatabaseConfigError);
      const sentence = (refusal as Error).message;
      expect(sentence).toMatch(REFUSAL_NAMES[field]);
      const others = await Promise.all([undefined, ""].map((value) => connectError(type, field, value)));
      for (const other of others) {
        expect(other).toBeInstanceOf(Error);
        expect((other as Error).message).not.toBe(sentence);
      }
    },
  );
});
