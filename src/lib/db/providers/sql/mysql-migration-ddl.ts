/**
 * MySQL drops an index with `ON <table>` and a foreign key with `DROP FOREIGN KEY`, and restates the whole column in
 * `MODIFY COLUMN`; everything else is the shared statement, wrapped in `BEGIN;` and `COMMIT;`.
 */
import {
  BEGIN_COMMIT,
  defaultSql,
  standardAddColumn,
  standardAddForeignKey,
  standardColumnDef,
  standardCreateIndex,
  standardCreateTableForeignKey,
  standardDropColumn,
  standardDropTable,
  standardPrimaryKey,
} from "@/lib/db/migration-ddl/shared";
import type { MigrationDdlSpec } from "@/lib/db/migration-ddl/types";

export const MYSQL_MIGRATION_DDL: MigrationDdlSpec = {
  tableDdl: "written",
  transactionWrapper: BEGIN_COMMIT,
  createTable: { kind: "written", primaryKey: standardPrimaryKey, foreignKey: standardCreateTableForeignKey },
  columnDef: standardColumnDef,
  createIndex: standardCreateIndex,
  dropIndex: (index, table) => `DROP INDEX ${index.name} ON ${table};`,
  addForeignKey: standardAddForeignKey,
  dropForeignKey: (constraint, table) => `ALTER TABLE ${table} DROP FOREIGN KEY ${constraint};`,
  addColumn: standardAddColumn,
  dropColumn: standardDropColumn,
  modifyColumn: (col, column, table) => {
    const type = col.targetType || col.sourceType || "TEXT";
    const nullable = col.targetNullable === false ? " NOT NULL" : " NULL";
    const declaredDefault = defaultSql(col);
    const defaultVal = declaredDefault === undefined ? "" : ` DEFAULT ${declaredDefault}`;
    return [`ALTER TABLE ${table} MODIFY COLUMN ${column} ${type}${nullable}${defaultVal};`];
  },
  dropTable: standardDropTable,
  reasons: [],
};
