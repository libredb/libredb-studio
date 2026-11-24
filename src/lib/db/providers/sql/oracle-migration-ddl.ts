/**
 * Oracle's own migration DDL functions, each bound by Studio's migration DDL function table (`MIGRATION_DDL_FUNCTIONS`
 * in src/lib/db/migration-ddl/index.ts) at the slot its name gives. Oracle has no `IF EXISTS` on `DROP CONSTRAINT` or
 * `DROP INDEX`, so a dropped foreign key or index is written bare, and its drops omit version-dependent IF EXISTS
 * clauses, `DROP TABLE` included. The live regression probe is tests/live/schema-diff-dialects.ts.
 */
import { defaultSql } from "@/lib/db/migration-ddl/shared";
import type { TableDdlWritten } from "@/lib/db/migration-ddl/types";

export const ORACLE_COLUMN_DEF: TableDdlWritten["columnDef"] = (col, column) => {
  const type = col.targetType || col.sourceType || "VARCHAR2(255)";
  const nullable = col.targetNullable === false ? " NOT NULL" : "";
  const value = defaultSql(col);
  const defaultVal = value === undefined ? "" : ` DEFAULT ${value}`;
  // Oracle's column grammar puts DEFAULT before inline constraints such as NOT NULL.
  return `${column} ${type}${defaultVal}${nullable}`;
};

export const ORACLE_DROP_INDEX: TableDdlWritten["dropIndex"] = (index) => `DROP INDEX ${index.qualifiedName};`;

export const ORACLE_DROP_FOREIGN_KEY: TableDdlWritten["dropForeignKey"] = (constraint, table) =>
  `ALTER TABLE ${table} DROP CONSTRAINT ${constraint};`;

export const ORACLE_ADD_COLUMN: TableDdlWritten["addColumn"] = (definition, table) =>
  `ALTER TABLE ${table} ADD (${definition});`;

export const ORACLE_MODIFY_COLUMN: TableDdlWritten["modifyColumn"] = (col, column, table) => {
  const type = col.targetType || col.sourceType || "VARCHAR2(255)";
  // Oracle refuses a nullability the column already has (#1240): a type change that
  // restates ` NULL` on a nullable column is ORA-01451, and the column keeps its old type.
  // So the clause is written only when the nullability changes.
  const nullable =
    col.sourceNullable === col.targetNullable ? "" : col.targetNullable === false ? " NOT NULL" : " NULL";
  const declaredDefault = defaultSql(col);
  const defaultVal = declaredDefault === undefined ? "" : ` DEFAULT ${declaredDefault}`;
  return [`ALTER TABLE ${table} MODIFY (${column} ${type}${defaultVal}${nullable});`];
};

export const ORACLE_DROP_TABLE: TableDdlWritten["dropTable"] = (table) => `DROP TABLE ${table};`;
