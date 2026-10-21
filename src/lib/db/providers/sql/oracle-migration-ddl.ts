/**
 * Oracle DDL commits implicitly and BEGIN opens a PL/SQL block, not a transaction, so the migration has no wrapper.
 * Oracle has no `IF EXISTS` on `DROP CONSTRAINT` or `DROP INDEX`, so a dropped foreign key or index is written bare,
 * and its drops omit version-dependent IF EXISTS clauses, `DROP TABLE` included. The live regression probe is
 * tests/live/schema-diff-dialects.ts.
 */
import {
  defaultSql,
  standardAddForeignKey,
  standardCreateIndex,
  standardCreateTableForeignKey,
  standardDropColumn,
  standardPrimaryKey,
} from "@/lib/db/migration-ddl/shared";
import type { MigrationDdlSpec } from "@/lib/db/migration-ddl/types";

export const ORACLE_MIGRATION_DDL: MigrationDdlSpec = {
  tableDdl: "written",
  transactionWrapper: null,
  createTable: { kind: "written", primaryKey: standardPrimaryKey, foreignKey: standardCreateTableForeignKey },
  columnDef: (col, column) => {
    const type = col.targetType || col.sourceType || "VARCHAR2(255)";
    const nullable = col.targetNullable === false ? " NOT NULL" : "";
    const value = defaultSql(col);
    const defaultVal = value === undefined ? "" : ` DEFAULT ${value}`;
    // Oracle's column grammar puts DEFAULT before inline constraints such as NOT NULL.
    return `${column} ${type}${defaultVal}${nullable}`;
  },
  createIndex: standardCreateIndex,
  dropIndex: (index) => `DROP INDEX ${index.qualifiedName};`,
  addForeignKey: standardAddForeignKey,
  dropForeignKey: (constraint, table) => `ALTER TABLE ${table} DROP CONSTRAINT ${constraint};`,
  addColumn: (definition, table) => `ALTER TABLE ${table} ADD (${definition});`,
  dropColumn: standardDropColumn,
  modifyColumn: (col, column, table) => {
    const type = col.targetType || col.sourceType || "VARCHAR2(255)";
    // Oracle refuses a nullability the column already has (#1240): a type change that
    // restates ` NULL` on a nullable column is ORA-01451, and the column keeps its old type.
    // So the clause is written only when the nullability changes.
    const nullable =
      col.sourceNullable === col.targetNullable ? "" : col.targetNullable === false ? " NOT NULL" : " NULL";
    const declaredDefault = defaultSql(col);
    const defaultVal = declaredDefault === undefined ? "" : ` DEFAULT ${declaredDefault}`;
    return [`ALTER TABLE ${table} MODIFY (${column} ${type}${defaultVal}${nullable});`];
  },
  dropTable: (table) => `DROP TABLE ${table};`,
  reasons: [],
};
