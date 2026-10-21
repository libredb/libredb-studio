/**
 * Db2 (#786) has no wrapper for the Oracle reason: it has no standalone `BEGIN;`, and BEGIN opens a compound SQL
 * block. It has no `IF EXISTS` on `DROP CONSTRAINT` or `DROP INDEX` either, so a dropped foreign key or index is
 * written bare, measured on Db2 LUW 12.1.0.0: `ALTER TABLE "C" DROP CONSTRAINT IF EXISTS "fk_c"` and `DROP INDEX IF
 * EXISTS "ix_c"` are both SQL0104N at `EXISTS`, while the bare statements run. `DROP TABLE` keeps `IF EXISTS`.
 */
import {
  commentName,
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

// Db2 retypes a column with its own `ALTER COLUMN … SET DATA TYPE`, which the PostgreSQL branch
// this id would otherwise inherit does not emit, and several such changes leave the table
// REORG-pending until a REORG runs, which a flat migration file cannot schedule (#786). ADD and
// DROP COLUMN take the standard spelling, both measured on Db2 LUW 12.1.0.0.
const NO_COLUMN_MODIFICATION =
  "Db2 changes a column with ALTER COLUMN ... SET DATA TYPE and may leave the table REORG-pending; write the change by hand.";

export const DB2_MIGRATION_DDL: MigrationDdlSpec = {
  tableDdl: "written",
  transactionWrapper: null,
  createTable: { kind: "written", primaryKey: standardPrimaryKey, foreignKey: standardCreateTableForeignKey },
  columnDef: standardColumnDef,
  createIndex: standardCreateIndex,
  dropIndex: (index) => `DROP INDEX ${index.qualifiedName};`,
  addForeignKey: standardAddForeignKey,
  dropForeignKey: (constraint, table) => `ALTER TABLE ${table} DROP CONSTRAINT ${constraint};`,
  addColumn: standardAddColumn,
  dropColumn: standardDropColumn,
  modifyColumn: (col) => [
    `-- Db2 LUW: Cannot alter column "${commentName(col.columnName)}". ${NO_COLUMN_MODIFICATION}`,
  ],
  dropTable: standardDropTable,
  reasons: [NO_COLUMN_MODIFICATION],
};
