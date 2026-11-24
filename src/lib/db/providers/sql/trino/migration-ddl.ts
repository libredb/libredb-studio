/**
 * Trino's own migration DDL functions, each bound by Studio's migration DDL function table (`MIGRATION_DDL_FUNCTIONS`
 * in src/lib/db/migration-ddl/index.ts) at the slot its name gives. Trino has no index or foreign-key grammar
 * (docs/providers/trino.md §3.8), and its CREATE TABLE has no primary-key constraint, so an added table's key is
 * declined in a comment after the statement rather than written into it; the comment names no key column. Trino
 * was the first engine declined that way.
 */
import { commentName, NO_FOREIGN_KEY_CONSTRAINT } from "@/lib/db/migration-ddl/shared";
import type { TableDdlWritten, WrittenCreateTable } from "@/lib/db/migration-ddl/types";

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

export const TRINO_CREATE_TABLE_PRIMARY_KEY: WrittenCreateTable["primaryKey"] = () => ({
  after: `-- Trino: Cannot declare a primary key. ${NO_PRIMARY_KEY_CONSTRAINT}`,
});

export const TRINO_CREATE_TABLE_FOREIGN_KEY: WrittenCreateTable["foreignKey"] = () => ({
  after: `-- Trino: Cannot add a foreign key. ${NO_FOREIGN_KEY_CONSTRAINT}`,
});

export const TRINO_CREATE_INDEX: TableDdlWritten["createIndex"] = () => `-- ${NO_PORTABLE_INDEX_DDL}`;

export const TRINO_DROP_INDEX: TableDdlWritten["dropIndex"] = () => `-- ${NO_PORTABLE_INDEX_DDL}`;

export const TRINO_ADD_FOREIGN_KEY: TableDdlWritten["addForeignKey"] = () =>
  `-- Trino: Cannot add a foreign key. ${NO_FOREIGN_KEY_CONSTRAINT}`;

export const TRINO_DROP_FOREIGN_KEY: TableDdlWritten["dropForeignKey"] = () =>
  `-- Trino: Cannot drop a foreign key. ${NO_FOREIGN_KEY_CONSTRAINT}`;

export const TRINO_MODIFY_COLUMN: TableDdlWritten["modifyColumn"] = (col) => [
  `-- Trino: Cannot alter column "${commentName(col.columnName)}". ${NO_COLUMN_MODIFICATION}`,
];
