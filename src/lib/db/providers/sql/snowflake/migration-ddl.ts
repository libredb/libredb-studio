/**
 * Snowflake has no wrapper on Databend's reason: a DDL statement commits the open transaction, and each SQL API
 * statement runs in its own session, so a `BEGIN;` brackets nothing it could roll back (#284).
 */
import {
  commentName,
  defaultSql,
  standardAddColumn,
  standardAddForeignKey,
  standardColumnDef,
  standardCreateTableForeignKey,
  standardDropColumn,
  standardDropForeignKey,
  standardDropTable,
  standardPrimaryKey,
} from "@/lib/db/migration-ddl/shared";
import type { MigrationDdlSpec } from "@/lib/db/migration-ddl/types";

const NO_PORTABLE_INDEX_DDL =
  "Snowflake: Cannot generate index DDL. Snowflake has indexes only on hybrid tables; write the index change by hand.";

const DEFAULT_ONLY_A_SEQUENCE =
  "ALTER COLUMN sets a default only to a sequence's NEXTVAL; recreate the column with its default.";

export const SNOWFLAKE_MIGRATION_DDL: MigrationDdlSpec = {
  tableDdl: "written",
  transactionWrapper: null,
  createTable: { kind: "written", primaryKey: standardPrimaryKey, foreignKey: standardCreateTableForeignKey },
  columnDef: standardColumnDef,
  createIndex: () => `-- ${NO_PORTABLE_INDEX_DDL}`,
  dropIndex: () => `-- ${NO_PORTABLE_INDEX_DDL}`,
  addForeignKey: standardAddForeignKey,
  dropForeignKey: standardDropForeignKey,
  addColumn: standardAddColumn,
  dropColumn: standardDropColumn,
  modifyColumn: (col, column, table) => {
    // Snowflake's ALTER COLUMN spells a type change SET DATA TYPE, and sets a default only to a sequence's
    // NEXTVAL, so any other default is declined in words; dropping one is plain.
    const lines: string[] = [];
    if (col.sourceType !== col.targetType) {
      lines.push(`ALTER TABLE ${table} ALTER COLUMN ${column} SET DATA TYPE ${col.targetType};`);
    }
    if (col.sourceNullable !== col.targetNullable) {
      lines.push(`ALTER TABLE ${table} ALTER COLUMN ${column} ${col.targetNullable ? "DROP" : "SET"} NOT NULL;`);
    }
    if (col.sourceDefault !== col.targetDefault) {
      if (defaultSql(col) === undefined) {
        lines.push(`ALTER TABLE ${table} ALTER COLUMN ${column} DROP DEFAULT;`);
      } else {
        lines.push(
          `-- Snowflake: Cannot set the default of column "${commentName(col.columnName)}". ${DEFAULT_ONLY_A_SEQUENCE}`,
        );
      }
    }
    return lines;
  },
  dropTable: standardDropTable,
  reasons: [NO_PORTABLE_INDEX_DDL, DEFAULT_ONLY_A_SEQUENCE],
};
