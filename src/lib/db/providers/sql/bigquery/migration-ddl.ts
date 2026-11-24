/**
 * BigQuery's own migration DDL functions, each bound by Studio's migration DDL function table
 * (`MIGRATION_DDL_FUNCTIONS` in src/lib/db/migration-ddl/index.ts) at the slot its name gives: BigQuery has no
 * foreign-key constraint this generator could write, its CREATE TABLE declines the primary key in a comment after the
 * statement, and its index and column changes are declined in words.
 */
import { commentName, NO_FOREIGN_KEY_CONSTRAINT } from "@/lib/db/migration-ddl/shared";
import type { TableDdlWritten, WrittenCreateTable } from "@/lib/db/migration-ddl/types";

const NO_COLUMN_MODIFICATION =
  "BigQuery widens a column with ALTER COLUMN ... SET DATA TYPE only along its coercion rules, and nothing else; write the change by hand.";

const NO_PORTABLE_INDEX_DDL =
  "BigQuery: Cannot generate index DDL. BigQuery has search and vector indexes only; write the index change by hand.";

const NO_PRIMARY_KEY_CONSTRAINT = "BigQuery accepts a primary key only as PRIMARY KEY (...) NOT ENFORCED.";

export const BIGQUERY_CREATE_TABLE_PRIMARY_KEY: WrittenCreateTable["primaryKey"] = () => ({
  after: `-- BigQuery: Cannot declare a primary key. ${NO_PRIMARY_KEY_CONSTRAINT}`,
});

export const BIGQUERY_CREATE_TABLE_FOREIGN_KEY: WrittenCreateTable["foreignKey"] = () => ({
  after: `-- BigQuery: Cannot add a foreign key. ${NO_FOREIGN_KEY_CONSTRAINT}`,
});

export const BIGQUERY_CREATE_INDEX: TableDdlWritten["createIndex"] = () => `-- ${NO_PORTABLE_INDEX_DDL}`;

export const BIGQUERY_DROP_INDEX: TableDdlWritten["dropIndex"] = () => `-- ${NO_PORTABLE_INDEX_DDL}`;

export const BIGQUERY_ADD_FOREIGN_KEY: TableDdlWritten["addForeignKey"] = () =>
  `-- BigQuery: Cannot add a foreign key. ${NO_FOREIGN_KEY_CONSTRAINT}`;

export const BIGQUERY_DROP_FOREIGN_KEY: TableDdlWritten["dropForeignKey"] = () =>
  `-- BigQuery: Cannot drop a foreign key. ${NO_FOREIGN_KEY_CONSTRAINT}`;

export const BIGQUERY_MODIFY_COLUMN: TableDdlWritten["modifyColumn"] = (col) => [
  `-- BigQuery: Cannot alter column "${commentName(col.columnName)}". ${NO_COLUMN_MODIFICATION}`,
];
