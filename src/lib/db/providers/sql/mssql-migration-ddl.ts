/**
 * SQL Server wraps the migration in `BEGIN TRANSACTION;` rather than `BEGIN;`, adds a column with a bare `ADD`, and
 * drops an index with `ON <table>`.
 */
import {
  defaultSql,
  standardAddForeignKey,
  standardColumnDef,
  standardCreateIndex,
  standardCreateTableForeignKey,
  standardDropColumn,
  standardDropForeignKey,
  standardDropTable,
  standardPrimaryKey,
} from "@/lib/db/migration-ddl/shared";
import type { MigrationDdlSpec } from "@/lib/db/migration-ddl/types";

export const MSSQL_MIGRATION_DDL: MigrationDdlSpec = {
  tableDdl: "written",
  transactionWrapper: { begin: "BEGIN TRANSACTION;", commit: "COMMIT;" },
  createTable: { kind: "written", primaryKey: standardPrimaryKey, foreignKey: standardCreateTableForeignKey },
  columnDef: standardColumnDef,
  createIndex: standardCreateIndex,
  dropIndex: (index, table) => `DROP INDEX IF EXISTS ${index.name} ON ${table};`,
  addForeignKey: standardAddForeignKey,
  dropForeignKey: standardDropForeignKey,
  addColumn: (definition, table) => `ALTER TABLE ${table} ADD ${definition};`,
  dropColumn: standardDropColumn,
  modifyColumn: (col, column, table) => {
    const lines: string[] = [];
    const type = col.targetType || col.sourceType || "NVARCHAR(MAX)";
    const nullable = col.targetNullable === false ? " NOT NULL" : " NULL";
    lines.push(`ALTER TABLE ${table} ALTER COLUMN ${column} ${type}${nullable};`);
    const declaredDefault = defaultSql(col);
    if (col.sourceDefault !== col.targetDefault && declaredDefault !== undefined) {
      lines.push(`ALTER TABLE ${table} ADD DEFAULT ${declaredDefault} FOR ${column};`);
    }
    return lines;
  },
  dropTable: standardDropTable,
  reasons: [],
};
