/**
 * MySQL's own migration DDL functions, each bound by Studio's migration DDL function table (`MIGRATION_DDL_FUNCTIONS`
 * in src/lib/db/migration-ddl/index.ts) at the slot its name gives: MySQL drops an index with `ON <table>` and a
 * foreign key with `DROP FOREIGN KEY`, and restates the whole column in `MODIFY COLUMN`.
 */
import { defaultSql } from "@/lib/db/migration-ddl/shared";
import type { TableDdlWritten } from "@/lib/db/migration-ddl/types";

export const MYSQL_DROP_INDEX: TableDdlWritten["dropIndex"] = (index, table) => `DROP INDEX ${index.name} ON ${table};`;

export const MYSQL_DROP_FOREIGN_KEY: TableDdlWritten["dropForeignKey"] = (constraint, table) =>
  `ALTER TABLE ${table} DROP FOREIGN KEY ${constraint};`;

export const MYSQL_MODIFY_COLUMN: TableDdlWritten["modifyColumn"] = (col, column, table) => {
  const type = col.targetType || col.sourceType || "TEXT";
  const nullable = col.targetNullable === false ? " NOT NULL" : " NULL";
  const declaredDefault = defaultSql(col);
  const defaultVal = declaredDefault === undefined ? "" : ` DEFAULT ${declaredDefault}`;
  return [`ALTER TABLE ${table} MODIFY COLUMN ${column} ${type}${nullable}${defaultVal};`];
};
