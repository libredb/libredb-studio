/**
 * Trino's transactional semantics are the CONNECTOR's answer, not a property of Trino itself, so no portable
 * `BEGIN;`/`COMMIT;` exists and the migration has no wrapper (#284). Trino has no index or foreign-key grammar
 * (docs/providers/trino.md §3.8), and its CREATE TABLE has no primary-key constraint, so an added table's key is
 * declined in a comment after the statement rather than written into it; the comment names no key column. Trino
 * was the first engine declined that way.
 */
import {
  commentName,
  NO_FOREIGN_KEY_CONSTRAINT,
  standardAddColumn,
  standardColumnDef,
  standardDropColumn,
  standardDropTable,
} from "@/lib/db/migration-ddl/shared";
import type { MigrationDdlSpec } from "@/lib/db/migration-ddl/types";

// Measured 2026-08-20 on Trino 476, and the reason exists because the PostgreSQL
// branch this id would otherwise inherit emits text Trino cannot even PARSE:
// `ALTER TABLE ... ALTER COLUMN id TYPE varchar` is "line 1:50: mismatched input
// 'TYPE'. Expecting: '.', 'DROP', 'SET'". Trino's own spelling
// (`ALTER COLUMN id SET DATA TYPE varchar`) parses and then hands the question to
// the catalog, which answered "This connector does not support setting column
// types" - so there is no single statement a portable migration could carry, and
// which one would work is a property of the catalog rather than of Trino.
const NO_COLUMN_MODIFICATION =
  "Whether a column can be retyped is the connector's answer, not Trino's; run the change in the system the catalog points at.";

const NO_PORTABLE_INDEX_DDL =
  "Trino: Cannot generate index DDL. Indexes belong to the connector's underlying system, not Trino SQL.";

const NO_PRIMARY_KEY_CONSTRAINT = "Trino SQL has no primary-key constraint.";

export const TRINO_MIGRATION_DDL: MigrationDdlSpec = {
  tableDdl: "written",
  transactionWrapper: null,
  createTable: {
    kind: "written",
    primaryKey: () => ({ after: `-- Trino: Cannot declare a primary key. ${NO_PRIMARY_KEY_CONSTRAINT}` }),
    foreignKey: () => ({ after: `-- Trino: Cannot add a foreign key. ${NO_FOREIGN_KEY_CONSTRAINT}` }),
  },
  columnDef: standardColumnDef,
  createIndex: () => `-- ${NO_PORTABLE_INDEX_DDL}`,
  dropIndex: () => `-- ${NO_PORTABLE_INDEX_DDL}`,
  addForeignKey: () => `-- Trino: Cannot add a foreign key. ${NO_FOREIGN_KEY_CONSTRAINT}`,
  dropForeignKey: () => `-- Trino: Cannot drop a foreign key. ${NO_FOREIGN_KEY_CONSTRAINT}`,
  addColumn: standardAddColumn,
  dropColumn: standardDropColumn,
  modifyColumn: (col) => [`-- Trino: Cannot alter column "${commentName(col.columnName)}". ${NO_COLUMN_MODIFICATION}`],
  dropTable: standardDropTable,
  reasons: [NO_COLUMN_MODIFICATION, NO_PORTABLE_INDEX_DDL, NO_FOREIGN_KEY_CONSTRAINT, NO_PRIMARY_KEY_CONSTRAINT],
};
