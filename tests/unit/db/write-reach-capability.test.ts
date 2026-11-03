import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { READ_ONLY_ENFORCED, SHIPPED_DATABASE_TYPES, WRITE_REACH } from "@/lib/db/compatibility";
import { NON_SQL_DESTRUCTIVE_VOCABULARY } from "@/lib/db/destructive-commands";
import { createDatabaseProvider } from "@/lib/db/factory";
import { MIGRATION_DDL } from "@/lib/db/migration-ddl";
import { SQL_WRITING } from "@/lib/db/sql-writing";
import type { DatabaseProvider, ProviderCapabilities, WritePath } from "@/lib/db/types";
import { summarizeWriteReach, WRITE_PATHS } from "@/lib/db/write-reach";
import type { DatabaseType } from "@/lib/types";
import { CENSUS_CONNECTION } from "../../helpers/census-connection";

/** A stand-in the census connection never holds, built so a secret scanner reads no literal assignment. */
const OTHER_PASSWORD = ["not", "a", "real", "password"].join("-");

/**
 * `WRITE_REACH` against what each provider declares, and each declaration against the capabilities it describes.
 *
 * The record is static because its readers decide before any provider exists, so the failure that matters is the
 * record, the provider's `writeReach` and the provider's real write surface disagreeing: an engine called `none`
 * that offers an object edit, or a `guarded` one with a write path no gate refuses. This census builds every shipped
 * provider and holds the three equal.
 *
 * A write path is present when its capability or method exists: object edit when the provider has `applyObjectEdit`
 * or any kind accepts a source edit; maintenance when `supportsMaintenance` holds with at least one operation;
 * transaction when `supportsTransactions` holds or any of the methods the transaction route keys on exists; and the
 * editor when the confirmation vocabulary names a destructive operation, any kind accepts row writes, or the provider
 * offers Create Table, inline row edit or test data. `runMaintenance` is abstract on the base class, so every provider
 * has one; the maintenance route reads the capability before calling it.
 *
 * Nothing here connects: `createDatabaseProvider` is a switch over dynamic imports and a constructor, the reading
 * `CENSUS_CONNECTION` documents.
 */
const ROOT = join(import.meta.dir, "..", "..", "..");

/**
 * The map `READ_ONLY_ENFORCED` held before it was derived from the record, so deriving it changes no answer, with
 * two entries flipped since: Prometheus, once a test held its closed endpoint table to reads, and Kafka, once a test
 * held its client's API key set to reads.
 */
const READ_ONLY_ENFORCED_BEFORE: Readonly<Record<DatabaseType, boolean>> = {
  postgres: false,
  bigquery: false,
  snowflake: false,
  spark: false,
  mysql: false,
  sqlite: false,
  libsql: false,
  duckdb: false,
  oracle: false,
  db2: false,
  mssql: false,
  clickhouse: false,
  druid: false,
  trino: false,
  cassandra: false,
  elasticsearch: false,
  opensearch: false,
  mongodb: false,
  couchbase: false,
  redis: false,
  prometheus: true,
  kafka: true,
  etcd: true,
  neo4j: true,
  milvus: true,
  qdrant: true,
  weaviate: true,
  influxdb: true,
  influxdb3: true,
  oxia: true,
  databend: false,
  s3: true,
  kubernetes: true,
  mqtt: true,
  firestore: true,
  rabbitmq: true,
  opcua: true,
  mtconnect: true,
  modbus: true,
  netconf: true,
  snmp: true,
  sparkplug: true,
  libredb: false,
};

const TRANSACTION_METHODS = ["beginTransaction", "commitTransaction", "rollbackTransaction", "queryInTransaction"];
const WRITE_METHODS = [
  "buildObjectEdit",
  "applyObjectEdit",
  ...TRANSACTION_METHODS,
  "endOpenQueryTransaction",
] as const;

const capabilitiesOf = async (type: DatabaseType): Promise<ProviderCapabilities> =>
  (await createDatabaseProvider(CENSUS_CONNECTION[type])).getCapabilities();

const hasMethod = (provider: DatabaseProvider, name: string): boolean =>
  typeof (provider as unknown as Record<string, unknown>)[name] === "function";

/** Which write paths a provider really offers, read from its capabilities and methods, never from its declaration. */
function presentPaths(type: DatabaseType, provider: DatabaseProvider): Record<WritePath, boolean> {
  const capabilities = provider.getCapabilities();
  const kinds = capabilities.objectKinds ?? [];
  const vocabulary = NON_SQL_DESTRUCTIVE_VOCABULARY[type];
  return {
    editor:
      (vocabulary !== undefined && vocabulary.operations.size > 0) ||
      kinds.some((kind) => kind.acceptsRowWrites === true) ||
      capabilities.createTable !== undefined ||
      capabilities.supportsInlineRowEdit === true ||
      capabilities.supportsTestDataGeneration === true,
    objectEdit: hasMethod(provider, "applyObjectEdit") || kinds.some((kind) => kind.acceptsSourceEdits === true),
    maintenance: capabilities.supportsMaintenance === true && (capabilities.maintenanceOperations ?? []).length > 0,
    transaction:
      capabilities.supportsTransactions === true || TRANSACTION_METHODS.some((name) => hasMethod(provider, name)),
  };
}

const ofReach = (reach: string) => SHIPPED_DATABASE_TYPES.filter((type) => WRITE_REACH[type] === reach);

describe("WRITE_REACH against each provider's own declaration", () => {
  test("answers for every shipped type-id and for nothing else, frozen", () => {
    expect(Object.keys(WRITE_REACH).sort()).toEqual([...SHIPPED_DATABASE_TYPES].sort());
    expect(Object.isFrozen(WRITE_REACH)).toBe(true);
  });

  test("READ_ONLY_ENFORCED, now derived from the record, answers what it answered before, bar the flipped entries", () => {
    expect({ ...READ_ONLY_ENFORCED }).toEqual(READ_ONLY_ENFORCED_BEFORE);
    expect(Object.isFrozen(READ_ONLY_ENFORCED)).toBe(true);
  });

  test.each([...SHIPPED_DATABASE_TYPES])(
    "%s: the record answers the summary of its provider's declaration",
    async (type) => {
      const capabilities = await capabilitiesOf(type);
      expect(WRITE_REACH[type]).toBe(summarizeWriteReach(capabilities.writeReach));
    },
  );

  test.each([...SHIPPED_DATABASE_TYPES])(
    "%s: a declaration names all four paths and is one frozen constant, whatever the connection holds",
    async (type) => {
      const declared = (await capabilitiesOf(type)).writeReach;
      if (declared === undefined) return;
      expect(Object.keys(declared).sort()).toEqual([...WRITE_PATHS].sort());
      expect(Object.isFrozen(declared)).toBe(true);
      for (const path of WRITE_PATHS) expect(Object.isFrozen(declared[path])).toBe(true);
      // The capabilities reach the browser through provider-meta, so a connection with other credentials and host
      // must get the very same object, and no value the census connection supplies may appear in it.
      const other = await createDatabaseProvider({
        ...CENSUS_CONNECTION[type],
        id: "census-other",
        user: "not-a-real-user",
        password: OTHER_PASSWORD,
      });
      expect(other.getCapabilities().writeReach).toBe(declared);
      const text = JSON.stringify(declared);
      for (const value of ["not-a-real-user", OTHER_PASSWORD, "127.0.0.1", "census-other"]) {
        expect(text).not.toContain(value);
      }
    },
  );

  test("the record reads 22 open, 2 guarded and 19 none", () => {
    expect(ofReach("open")).toHaveLength(22);
    expect(ofReach("guarded")).toEqual(["etcd", "milvus"]);
    expect(ofReach("none")).toHaveLength(19);
  });
});

describe("a none provider declares no write capability on any path", () => {
  test.each(ofReach("none"))("%s", async (type) => {
    const provider = await createDatabaseProvider(CENSUS_CONNECTION[type]);
    const capabilities = provider.getCapabilities();
    expect(capabilities.supportsInlineRowEdit).not.toBe(true);
    expect(capabilities.supportsTestDataGeneration).not.toBe(true);
    expect(capabilities.supportsMaintenance).not.toBe(true);
    expect(capabilities.supportsTransactions).not.toBe(true);
    expect(capabilities.createTable).toBeUndefined();
    expect(capabilities.maintenanceOperations ?? []).toEqual([]);
    for (const kind of capabilities.objectKinds ?? []) {
      expect(kind.acceptsRowWrites).not.toBe(true);
      expect(kind.acceptsSourceEdits).not.toBe(true);
    }
    for (const name of WRITE_METHODS) expect(hasMethod(provider, name)).toBe(false);
    expect(SQL_WRITING[type]?.insertDocuments).toBeUndefined();
    expect(MIGRATION_DDL[type].tableDdl).toBe("refused");
    expect(NON_SQL_DESTRUCTIVE_VOCABULARY[type]?.operations.size ?? 0).toBe(0);

    const declared = capabilities.writeReach;
    expect(declared?.editor).toMatchObject({ reach: "absent", proof: expect.any(Object) });
    for (const path of ["objectEdit", "maintenance", "transaction"] as const) {
      expect(declared?.[path]).toEqual({ reach: "absent" });
    }
  });
});

describe("a guarded provider names the gate on every write path it has", () => {
  test.each(ofReach("guarded"))(
    "%s: every present path is gated and every absent one is really absent",
    async (type) => {
      const provider = await createDatabaseProvider(CENSUS_CONNECTION[type]);
      const declared = provider.getCapabilities().writeReach;
      const present = presentPaths(type, provider);
      for (const path of WRITE_PATHS) {
        const reach = declared?.[path];
        if (present[path]) {
          expect({ path, reach: reach?.reach }).toEqual({ path, reach: "gated" });
        } else {
          expect({ path, reach: reach?.reach }).toEqual({ path, reach: "absent" });
          if (path === "editor") expect(reach).toMatchObject({ proof: expect.any(Object) });
        }
      }
    },
  );

  test.each(ofReach("guarded"))("%s keeps a read-only end-to-end test over its gated paths", (type) => {
    expect(existsSync(join(ROOT, "tests", "unit", "db", type, "read-only-end-to-end.test.ts"))).toBe(true);
  });
});
