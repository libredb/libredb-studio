/**
 * An engine's migration DDL row rebuilt from the `migrationDdl` segment of its engine declaration, as a host that admits
 * the declaration would build one (docs/providers/CONTRACT.md, clause S-17).
 *
 * Every data member comes from the declaration: the form, the refusal line, the transaction wrapper, the CREATE TABLE
 * kind and the reasons. Each function is resolved by the slot name the declaration states, through the census's slot
 * table, on the row the engine's own module exports: the declaration says which slot, the module supplies the function,
 * so a name stated at the wrong member moves a function to where the migration then runs it.
 *
 * It is written apart from scripts/generate-engine-declarations.ts, which reads back only a declaration's authored members.
 */
import type { MigrationDdl } from "@libredb/provider-sdk/manifest";
import type { CreateTableDdl, MigrationDdlSpec, TableDdlWritten } from "@/lib/db/migration-ddl/types";
import { DECLARED_SLOTS, isDeclaredSlotName, slotFunction } from "./declared-slots";

/**
 * The row of engine `type` that `declared` states, every function resolved by its slot name on `row`, the row the
 * engine's own module exports. A name that is no migration DDL slot of the census's table, and a slot `row` does not
 * fill with a function, are thrown by name.
 */
export function migrationDdlFromDeclaration(type: string, declared: MigrationDdl, row: object): MigrationDdlSpec {
  const resolve = <Fn>(name: string): Fn => {
    if (!isDeclaredSlotName(name) || DECLARED_SLOTS[name].table !== "MIGRATION_DDL") {
      throw new Error(`${type}: the declaration names "${name}", which is no migration DDL slot of the census's table`);
    }
    const held = slotFunction(row, name);
    if (typeof held !== "function") {
      throw new Error(`${type}: the slot "${name}" holds no function in the module's row`);
    }
    return held as Fn;
  };

  if (declared.tableDdl === "refused") {
    return {
      tableDdl: "refused",
      refusal: declared.refusal,
      transactionWrapper: declared.transactionWrapper,
      reasons: [...declared.reasons],
    };
  }

  const { createTable: stated, transactionWrapper: wrapper } = declared;
  const createTable: CreateTableDdl =
    stated.kind === "refused"
      ? {
          kind: "refused",
          createTableRefusal: resolve<Extract<CreateTableDdl, { kind: "refused" }>["createTableRefusal"]>(
            stated.createTableRefusal,
          ),
        }
      : {
          kind: "written",
          primaryKey: resolve<Extract<CreateTableDdl, { kind: "written" }>["primaryKey"]>(stated.primaryKey),
          foreignKey: resolve<Extract<CreateTableDdl, { kind: "written" }>["foreignKey"]>(stated.foreignKey),
        };

  return {
    tableDdl: "written",
    transactionWrapper: wrapper === null ? null : { begin: wrapper.begin, commit: wrapper.commit },
    createTable,
    columnDef: resolve<TableDdlWritten["columnDef"]>(declared.columnDef),
    createIndex: resolve<TableDdlWritten["createIndex"]>(declared.createIndex),
    dropIndex: resolve<TableDdlWritten["dropIndex"]>(declared.dropIndex),
    addForeignKey: resolve<TableDdlWritten["addForeignKey"]>(declared.addForeignKey),
    dropForeignKey: resolve<TableDdlWritten["dropForeignKey"]>(declared.dropForeignKey),
    addColumn: resolve<TableDdlWritten["addColumn"]>(declared.addColumn),
    dropColumn: resolve<TableDdlWritten["dropColumn"]>(declared.dropColumn),
    modifyColumn: resolve<TableDdlWritten["modifyColumn"]>(declared.modifyColumn),
    dropTable: resolve<TableDdlWritten["dropTable"]>(declared.dropTable),
    reasons: [...declared.reasons],
  };
}
