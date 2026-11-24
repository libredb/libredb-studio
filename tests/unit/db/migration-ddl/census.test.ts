/**
 * The migration DDL registry is total over the type-id union, each row its declaration's migration DDL composed with
 * Studio's migration DDL function table (docs/providers/CONTRACT.md, clause M-80), and its reader answers no connection
 * and a type id by name and refuses every other value outside the `DatabaseType` union by name (FND-1).
 */
import { describe, expect, test } from "bun:test";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { BUNDLED_MIGRATION_DDL } from "@/lib/db/engine-catalog/migration-ddl.generated";
import {
  composeMigrationDdl,
  MIGRATION_DDL,
  MIGRATION_DDL_FUNCTIONS,
  migrationDdlFor,
  migrationDialectHeader,
} from "@/lib/db/migration-ddl";
import { DEFAULT_CONNECTION_TYPE } from "@/lib/db/default-connection-type";
import { NO_CONNECTION_MIGRATION_DDL } from "@/lib/db/migration-ddl/no-connection";
import type { DatabaseType } from "@/lib/types";
import { OUTSIDE_THE_UNION, refusalOf, refusalThrownBy } from "../../../helpers/outside-the-union";

const REFUSED: DatabaseType[] = [
  "mongodb",
  "redis",
  "libredb",
  "couchbase",
  "druid",
  "elasticsearch",
  "opensearch",
  "prometheus",
  "kafka",
  "etcd",
  "neo4j",
  "milvus",
  "qdrant",
  "weaviate",
  "influxdb",
  "influxdb3",
  "oxia",
  "s3",
  "kubernetes",
  "mqtt",
  "firestore",
  "rabbitmq",
  "opcua",
  "mtconnect",
  "modbus",
  "netconf",
  "snmp",
  "sparkplug",
];

const ids = Object.keys(MIGRATION_DDL) as DatabaseType[];

describe("migration DDL registry census", () => {
  test("one row per shipped type id", () => {
    expect([...ids].sort()).toEqual([...SHIPPED_DATABASE_TYPES].sort());
    expect(Object.keys(BUNDLED_MIGRATION_DDL).sort()).toEqual([...ids].sort());
  });

  for (const id of SHIPPED_DATABASE_TYPES) {
    test(`${id}: the row is its declaration's migration DDL composed with Studio's migration DDL function table`, () => {
      expect(MIGRATION_DDL[id]).toEqual(composeMigrationDdl(id, BUNDLED_MIGRATION_DDL[id], MIGRATION_DDL_FUNCTIONS));
    });
  }

  test("every row is its own object, distinct from the no-connection spec", () => {
    const rows = ids.map((id) => MIGRATION_DDL[id]);
    expect(new Set(rows).size).toBe(rows.length);
    expect(rows).not.toContain(NO_CONNECTION_MIGRATION_DDL);
  });

  test("the registry is frozen", () => {
    expect(Object.isFrozen(MIGRATION_DDL)).toBe(true);
  });

  test("the refused ids are the REFUSED list, the engines that print no table DDL", () => {
    expect(ids.filter((id) => MIGRATION_DDL[id].tableDdl === "refused").sort()).toEqual([...REFUSED].sort());
  });

  test("the reader answers no connection and a member by name", () => {
    expect(migrationDdlFor(undefined)).toBe(NO_CONNECTION_MIGRATION_DDL);
    expect(migrationDdlFor("postgres")).toBe(MIGRATION_DDL.postgres);
  });

  test.each(OUTSIDE_THE_UNION)("migrationDdlFor refuses %s by name", (_label, value) => {
    expect(refusalThrownBy(() => migrationDdlFor(value as string))).toEqual(refusalOf(value));
  });

  test("the no-connection dialect is the word SchemaDiff passed, the default connection type", () => {
    expect(DEFAULT_CONNECTION_TYPE).toBe("postgres");
  });

  test("the header word is the no-connection dialect with no connection and the type id otherwise", () => {
    expect(migrationDialectHeader(undefined)).toBe(DEFAULT_CONNECTION_TYPE);
    for (const type of ["postgres", "mysql"]) {
      expect(migrationDialectHeader(type)).toBe(type);
    }
  });

  test.each(OUTSIDE_THE_UNION)("migrationDialectHeader refuses %s by name", (_label, value) => {
    expect(refusalThrownBy(() => migrationDialectHeader(value as string))).toEqual(refusalOf(value));
  });
});
