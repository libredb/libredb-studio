/**
 * Studio's migration DDL is composed when its module loads (docs/providers/CONTRACT.md, clause M-80): each engine's row
 * from the migration DDL its declaration authors, projected into src/lib/db/engine-catalog/migration-ddl.generated.ts,
 * and Studio's migration DDL function table, `MIGRATION_DDL_FUNCTIONS`, which binds each function name the declaration
 * gives.
 *
 * The golden files hold what the schema diff writes from the rows; this file holds the composition itself: a refused
 * form as its line, no wrapper and its reasons, naming no function; a written form with its wrapper, its CREATE TABLE
 * form and its nine writers, each bound at its own slot or refused by name; and every row and record frozen.
 */
import { describe, expect, test } from "bun:test";
import { BUNDLED_MIGRATION_DDL } from "@/lib/db/engine-catalog/migration-ddl.generated";
import type { MigrationDdlEntry } from "@/lib/db/engine-catalog/projection";
import {
  composeMigrationDdl,
  MIGRATION_DDL,
  MIGRATION_DDL_FUNCTIONS,
  type MigrationDdlFunctions,
  migrationDdlFor,
} from "@/lib/db/migration-ddl";
import {
  standardAddColumn,
  standardCreateIndex,
  standardDropTable,
  standardModifyColumn,
  standardPrimaryKey,
} from "@/lib/db/migration-ddl/shared";
import { CASSANDRA_CREATE_TABLE_REFUSAL } from "@/lib/db/providers/sql/cassandra/migration-ddl";
import { MYSQL_DROP_INDEX, MYSQL_MODIFY_COLUMN } from "@/lib/db/providers/sql/mysql-migration-ddl";
import { ORACLE_DROP_TABLE } from "@/lib/db/providers/sql/oracle-migration-ddl";
import type { DatabaseType } from "@/lib/types";

const IDS = Object.keys(BUNDLED_MIGRATION_DDL) as DatabaseType[];

/** Whether `value` is frozen with every object under it, a function left as it is. */
function frozenThrough(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return true;
  return Object.isFrozen(value) && Object.values(value).every(frozenThrough);
}

/** The entry's written form, or null where it refuses table DDL. */
const written = (entry: MigrationDdlEntry) => (entry.tableDdl === "written" ? entry : null);

/** Each slot kind of the table, with the name an entry gives at that slot, or null where it fills none. */
const SLOT_NAMES: Readonly<Record<keyof MigrationDdlFunctions, (entry: MigrationDdlEntry) => string | null>> = {
  createTablePrimaryKeys: (entry) => {
    const createTable = written(entry)?.createTable;
    return createTable?.kind === "written" ? createTable.primaryKey : null;
  },
  createTableForeignKeys: (entry) => {
    const createTable = written(entry)?.createTable;
    return createTable?.kind === "written" ? createTable.foreignKey : null;
  },
  createTableRefusals: (entry) => {
    const createTable = written(entry)?.createTable;
    return createTable?.kind === "refused" ? createTable.createTableRefusal : null;
  },
  columnDefs: (entry) => written(entry)?.columnDef ?? null,
  createIndexes: (entry) => written(entry)?.createIndex ?? null,
  dropIndexes: (entry) => written(entry)?.dropIndex ?? null,
  addForeignKeys: (entry) => written(entry)?.addForeignKey ?? null,
  dropForeignKeys: (entry) => written(entry)?.dropForeignKey ?? null,
  addColumns: (entry) => written(entry)?.addColumn ?? null,
  dropColumns: (entry) => written(entry)?.dropColumn ?? null,
  modifyColumns: (entry) => written(entry)?.modifyColumn ?? null,
  dropTables: (entry) => written(entry)?.dropTable ?? null,
};

/** Each slot kind of the table, with the function a composed row holds at that slot. */
const ROW_FUNCTIONS: Readonly<Record<keyof MigrationDdlFunctions, (id: DatabaseType) => unknown>> = {
  createTablePrimaryKeys: (id) => {
    const row = MIGRATION_DDL[id];
    return row.tableDdl === "written" && row.createTable.kind === "written" ? row.createTable.primaryKey : undefined;
  },
  createTableForeignKeys: (id) => {
    const row = MIGRATION_DDL[id];
    return row.tableDdl === "written" && row.createTable.kind === "written" ? row.createTable.foreignKey : undefined;
  },
  createTableRefusals: (id) => {
    const row = MIGRATION_DDL[id];
    return row.tableDdl === "written" && row.createTable.kind === "refused"
      ? row.createTable.createTableRefusal
      : undefined;
  },
  columnDefs: (id) => writtenRow(id)?.columnDef,
  createIndexes: (id) => writtenRow(id)?.createIndex,
  dropIndexes: (id) => writtenRow(id)?.dropIndex,
  addForeignKeys: (id) => writtenRow(id)?.addForeignKey,
  dropForeignKeys: (id) => writtenRow(id)?.dropForeignKey,
  addColumns: (id) => writtenRow(id)?.addColumn,
  dropColumns: (id) => writtenRow(id)?.dropColumn,
  modifyColumns: (id) => writtenRow(id)?.modifyColumn,
  dropTables: (id) => writtenRow(id)?.dropTable,
};

function writtenRow(id: DatabaseType) {
  const row = MIGRATION_DDL[id];
  return row.tableDdl === "written" ? row : undefined;
}

/** The written entry of `id`, or a thrown error where its declaration refuses table DDL. */
function writtenEntry(id: DatabaseType) {
  const entry = BUNDLED_MIGRATION_DDL[id];
  if (entry.tableDdl !== "written") throw new Error(`${id}'s migration DDL writes no table DDL`);
  return entry;
}

describe("Studio's migration DDL, composed from the declarations", () => {
  test("each row is its declaration's migration DDL composed with Studio's migration DDL function table", () => {
    expect(Object.keys(MIGRATION_DDL)).toEqual(IDS);
    for (const id of IDS) {
      const entry = BUNDLED_MIGRATION_DDL[id];
      const row = MIGRATION_DDL[id];
      expect({ id, row }).toEqual({ id, row: composeMigrationDdl(id, entry, MIGRATION_DDL_FUNCTIONS) });
      expect(migrationDdlFor(id)).toBe(row);
      expect(row.tableDdl).toBe(entry.tableDdl);
      expect(row.reasons).toEqual(entry.reasons);
      expect(row.transactionWrapper).toEqual(entry.transactionWrapper);
      if (row.tableDdl === "written" && entry.tableDdl === "written") {
        expect(row.createTable.kind).toBe(entry.createTable.kind);
      }
    }
    // Every member of a written row, in the contract's order, and a wrapper as its two statements.
    expect(Object.keys(MIGRATION_DDL.mysql)).toEqual([
      "tableDdl",
      "transactionWrapper",
      "createTable",
      "columnDef",
      "createIndex",
      "dropIndex",
      "addForeignKey",
      "dropForeignKey",
      "addColumn",
      "dropColumn",
      "modifyColumn",
      "dropTable",
      "reasons",
    ]);
    expect(MIGRATION_DDL.mssql.transactionWrapper).toEqual({ begin: "BEGIN TRANSACTION;", commit: "COMMIT;" });
    expect(MIGRATION_DDL.mysql.transactionWrapper).toEqual({ begin: "BEGIN;", commit: "COMMIT;" });
    expect(MIGRATION_DDL.oracle.transactionWrapper).toBeNull();
  });

  test("a refused declaration composes to its refusal line, no wrapper and its reasons, naming no function", () => {
    const kafka = BUNDLED_MIGRATION_DDL.kafka;
    if (kafka.tableDdl !== "refused") throw new Error("kafka's migration DDL writes table DDL");
    expect(MIGRATION_DDL.kafka).toEqual({
      tableDdl: "refused",
      refusal: kafka.refusal,
      transactionWrapper: null,
      reasons: [...kafka.reasons],
    });
    expect(Object.keys(MIGRATION_DDL.kafka)).toEqual(["tableDdl", "refusal", "transactionWrapper", "reasons"]);
    // A refused entry composes with no function table at all: it names no function.
    const empty = Object.fromEntries(
      Object.keys(MIGRATION_DDL_FUNCTIONS).map((kind) => [kind, {}]),
    ) as unknown as MigrationDdlFunctions;
    expect(composeMigrationDdl("kafka", kafka, empty)).toEqual(MIGRATION_DDL.kafka);
    // A written entry does not.
    expect(() => composeMigrationDdl("postgres", writtenEntry("postgres"), empty)).toThrow(
      'postgres names the function "createTablePrimaryKey", which Studio holds no function for.',
    );
  });

  test("a written declaration's CREATE TABLE is written with its key writers or refused with its line writer", () => {
    const cassandra = MIGRATION_DDL.cassandra;
    if (cassandra.tableDdl !== "written") throw new Error("cassandra's migration DDL writes no table DDL");
    expect(cassandra.createTable).toEqual({ kind: "refused", createTableRefusal: CASSANDRA_CREATE_TABLE_REFUSAL });
    expect(Object.keys(cassandra.createTable)).toEqual(["kind", "createTableRefusal"]);
    const postgres = MIGRATION_DDL.postgres;
    if (postgres.tableDdl !== "written") throw new Error("postgres's migration DDL writes no table DDL");
    expect(Object.keys(postgres.createTable)).toEqual(["kind", "primaryKey", "foreignKey"]);
    expect(postgres.createTable.kind === "written" && postgres.createTable.primaryKey).toBe(standardPrimaryKey);
    // The building blocks and an engine's own function, each by identity.
    expect(postgres.createIndex).toBe(standardCreateIndex);
    expect(postgres.modifyColumn).toBe(standardModifyColumn);
    const mysql = MIGRATION_DDL.mysql;
    if (mysql.tableDdl !== "written") throw new Error("mysql's migration DDL writes no table DDL");
    expect(mysql.dropIndex).toBe(MYSQL_DROP_INDEX);
    expect(mysql.modifyColumn).toBe(MYSQL_MODIFY_COLUMN);
    expect(mysql.addColumn).toBe(standardAddColumn);
    const oracle = MIGRATION_DDL.oracle;
    if (oracle.tableDdl !== "written") throw new Error("oracle's migration DDL writes no table DDL");
    expect(oracle.dropTable).toBe(ORACLE_DROP_TABLE);
    expect(oracle.dropTable).not.toBe(standardDropTable);
  });

  test("the rows and their records are frozen", () => {
    expect(Object.isFrozen(MIGRATION_DDL)).toBe(true);
    for (const id of IDS) {
      expect({ id, frozen: frozenThrough(MIGRATION_DDL[id]) }).toEqual({ id, frozen: true });
    }
    // A composition answers a copy: the reasons and the wrapper are its own, not the entry's.
    const entry = writtenEntry("mssql");
    const composed = composeMigrationDdl("mssql", entry, MIGRATION_DDL_FUNCTIONS);
    expect(composed.reasons).not.toBe(entry.reasons);
    expect(composed.tableDdl === "written" && composed.transactionWrapper).not.toBe(entry.transactionWrapper);
    expect(frozenThrough(composed)).toBe(true);
  });

  test("a function name Studio holds none for is refused by name at its slot, a name it holds only at another slot included", () => {
    const mysql = writtenEntry("mysql");
    expect(() => composeMigrationDdl("mysql", { ...mysql, dropIndex: "createIndex" }, MIGRATION_DDL_FUNCTIONS)).toThrow(
      'mysql names the function "createIndex", which Studio holds no function for.',
    );
    const postgres = writtenEntry("postgres");
    expect(() =>
      composeMigrationDdl("postgres", { ...postgres, columnDef: "dropTable" }, MIGRATION_DDL_FUNCTIONS),
    ).toThrow('postgres names the function "dropTable", which Studio holds no function for.');
    expect(() =>
      composeMigrationDdl("postgres", { ...postgres, dropTable: "toString" }, MIGRATION_DDL_FUNCTIONS),
    ).toThrow('postgres names the function "toString", which Studio holds no function for.');
    // A CREATE TABLE form an engine does not hold: postgres writes its CREATE TABLE, so it holds no refusal writer.
    expect(() =>
      composeMigrationDdl(
        "postgres",
        { ...postgres, createTable: { kind: "refused", createTableRefusal: "createTableRefusal" } },
        MIGRATION_DDL_FUNCTIONS,
      ),
    ).toThrow('postgres names the function "createTableRefusal", which Studio holds no function for.');
    const cassandra = writtenEntry("cassandra");
    expect(() =>
      composeMigrationDdl(
        "cassandra",
        {
          ...cassandra,
          createTable: { kind: "written", primaryKey: "createTablePrimaryKey", foreignKey: "createTableForeignKey" },
        },
        MIGRATION_DDL_FUNCTIONS,
      ),
    ).toThrow('cassandra names the function "createTablePrimaryKey", which Studio holds no function for.');
    // A refused engine holds no function at any slot.
    const kafka = BUNDLED_MIGRATION_DDL.kafka;
    expect(() => composeMigrationDdl("kafka", { ...mysql, reasons: kafka.reasons }, MIGRATION_DDL_FUNCTIONS)).toThrow(
      'kafka names the function "createTablePrimaryKey", which Studio holds no function for.',
    );
  });

  test("Studio's migration DDL function table holds exactly the functions the committed declarations name, each at its own slot", () => {
    const tableNames = (table: Readonly<Record<string, Readonly<Record<string, unknown>> | undefined>>) =>
      Object.fromEntries(Object.entries(table).map(([id, slots]) => [id, Object.keys(slots ?? {})]));
    expect(Object.keys(MIGRATION_DDL_FUNCTIONS)).toEqual(Object.keys(SLOT_NAMES));
    for (const kind of Object.keys(SLOT_NAMES) as (keyof MigrationDdlFunctions)[]) {
      const named = Object.fromEntries(
        IDS.flatMap((id) => {
          const name = SLOT_NAMES[kind](BUNDLED_MIGRATION_DDL[id]);
          return name === null ? [] : [[id, [name]]];
        }),
      );
      expect({ kind, names: tableNames(MIGRATION_DDL_FUNCTIONS[kind]) }).toEqual({ kind, names: named });
      // Each row runs, at the slot, the very function the table binds there.
      for (const [id, slots] of Object.entries(MIGRATION_DDL_FUNCTIONS[kind]) as [DatabaseType, object][]) {
        expect({ kind, id, bound: ROW_FUNCTIONS[kind](id) === Object.values(slots)[0] }).toEqual({
          kind,
          id,
          bound: true,
        });
      }
    }
    // 164 bindings over the 15 engines that write table DDL.
    const bindings = Object.values(MIGRATION_DDL_FUNCTIONS).flatMap((table) => Object.keys(table));
    expect(bindings.length).toBe(164);
    expect(new Set(bindings).size).toBe(15);
    expect(MIGRATION_DDL_FUNCTIONS.createTableRefusals.cassandra?.createTableRefusal).toBe(
      CASSANDRA_CREATE_TABLE_REFUSAL,
    );
    expect(MIGRATION_DDL_FUNCTIONS.dropIndexes.mysql?.dropIndex).toBe(MYSQL_DROP_INDEX);
    expect(MIGRATION_DDL_FUNCTIONS.dropTables.oracle?.dropTable).toBe(ORACLE_DROP_TABLE);
    expect(MIGRATION_DDL_FUNCTIONS.dropTables.postgres?.dropTable).toBe(standardDropTable);
    expect(frozenThrough(MIGRATION_DDL_FUNCTIONS)).toBe(true);
  });
});
