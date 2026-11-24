/**
 * Snowflake's own migration DDL functions, each bound by Studio's migration DDL function table
 * (`MIGRATION_DDL_FUNCTIONS` in src/lib/db/migration-ddl/index.ts) at the slot its name gives: Snowflake has indexes
 * only on hybrid tables, so index changes are declined in words, and its column changes take its own spelling.
 */
import { commentName, defaultSql } from "@/lib/db/migration-ddl/shared";
import type { TableDdlWritten } from "@/lib/db/migration-ddl/types";

const NO_PORTABLE_INDEX_DDL =
  "Snowflake: Cannot generate index DDL. Snowflake has indexes only on hybrid tables; write the index change by hand.";

const DEFAULT_ONLY_A_SEQUENCE =
  "ALTER COLUMN sets a default only to a sequence's NEXTVAL; recreate the column with its default.";

export const SNOWFLAKE_CREATE_INDEX: TableDdlWritten["createIndex"] = () => `-- ${NO_PORTABLE_INDEX_DDL}`;

export const SNOWFLAKE_DROP_INDEX: TableDdlWritten["dropIndex"] = () => `-- ${NO_PORTABLE_INDEX_DDL}`;

export const SNOWFLAKE_MODIFY_COLUMN: TableDdlWritten["modifyColumn"] = (col, column, table) => {
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
};
