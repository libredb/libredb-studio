/**
 * Db2's own migration DDL functions (#786), each bound by Studio's migration DDL function table
 * (`MIGRATION_DDL_FUNCTIONS` in src/lib/db/migration-ddl/index.ts) at the slot its name gives. Db2 has no `IF EXISTS`
 * on `DROP CONSTRAINT` or `DROP INDEX`, so a dropped foreign key or index is written bare, measured on Db2 LUW
 * 12.1.0.0: `ALTER TABLE "C" DROP CONSTRAINT IF EXISTS "fk_c"` and `DROP INDEX IF EXISTS "ix_c"` are both SQL0104N at
 * `EXISTS`, while the bare statements run. `DROP TABLE` keeps `IF EXISTS`.
 */
import { commentName } from "@/lib/db/migration-ddl/shared";
import type { TableDdlWritten } from "@/lib/db/migration-ddl/types";

// Db2 retypes a column with its own `ALTER COLUMN … SET DATA TYPE`, which the PostgreSQL branch
// this id would otherwise inherit does not emit, and several such changes leave the table
// REORG-pending until a REORG runs, which a flat migration file cannot schedule (#786). ADD and
// DROP COLUMN take the standard spelling, both measured on Db2 LUW 12.1.0.0.
const NO_COLUMN_MODIFICATION =
  "Db2 changes a column with ALTER COLUMN ... SET DATA TYPE and may leave the table REORG-pending; write the change by hand.";

export const DB2_DROP_INDEX: TableDdlWritten["dropIndex"] = (index) => `DROP INDEX ${index.qualifiedName};`;

export const DB2_DROP_FOREIGN_KEY: TableDdlWritten["dropForeignKey"] = (constraint, table) =>
  `ALTER TABLE ${table} DROP CONSTRAINT ${constraint};`;

export const DB2_MODIFY_COLUMN: TableDdlWritten["modifyColumn"] = (col) => [
  `-- Db2 LUW: Cannot alter column "${commentName(col.columnName)}". ${NO_COLUMN_MODIFICATION}`,
];
