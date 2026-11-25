/**
 * SQL Server's own migration DDL functions, each bound by Studio's migration DDL function table
 * (`MIGRATION_DDL_FUNCTIONS` in src/lib/db/migration-ddl/index.ts) at the slot its name gives: SQL Server adds a column
 * with a bare `ADD`, drops an index with `ON <table>`, and restates a column's type and nullability in `ALTER COLUMN`.
 */
import { defaultSql } from "@/lib/db/migration-ddl/shared";
import type { TableDdlWritten } from "@/lib/db/migration-ddl/types";

export const MSSQL_DROP_INDEX: TableDdlWritten["dropIndex"] = (index, table) =>
  `DROP INDEX IF EXISTS ${index.name} ON ${table};`;

export const MSSQL_ADD_COLUMN: TableDdlWritten["addColumn"] = (definition, table) =>
  `ALTER TABLE ${table} ADD ${definition};`;

export const MSSQL_MODIFY_COLUMN: TableDdlWritten["modifyColumn"] = (col, column, table) => {
  const lines: string[] = [];
  const type = col.targetType || col.sourceType || "NVARCHAR(MAX)";
  const nullable = col.targetNullable === false ? " NOT NULL" : " NULL";
  lines.push(`ALTER TABLE ${table} ALTER COLUMN ${column} ${type}${nullable};`);
  const declaredDefault = defaultSql(col);
  if (col.sourceDefault !== col.targetDefault && declaredDefault !== undefined) {
    lines.push(`ALTER TABLE ${table} ADD DEFAULT ${declaredDefault} FOR ${column};`);
  }
  return lines;
};
