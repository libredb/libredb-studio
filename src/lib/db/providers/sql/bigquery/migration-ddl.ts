/**
 * BigQuery runs a statement as its own job; BEGIN TRANSACTION exists only inside a multi-statement script, so the
 * migration has no wrapper (#284). It has no foreign-key constraint this generator could write, and its CREATE TABLE
 * declines the primary key in a comment after the statement.
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

const NO_COLUMN_MODIFICATION =
  "BigQuery widens a column with ALTER COLUMN ... SET DATA TYPE only along its coercion rules, and nothing else; write the change by hand.";

const NO_PORTABLE_INDEX_DDL =
  "BigQuery: Cannot generate index DDL. BigQuery has search and vector indexes only; write the index change by hand.";

const NO_PRIMARY_KEY_CONSTRAINT = "BigQuery accepts a primary key only as PRIMARY KEY (...) NOT ENFORCED.";

export const BIGQUERY_MIGRATION_DDL: MigrationDdlSpec = {
  tableDdl: "written",
  transactionWrapper: null,
  createTable: {
    kind: "written",
    primaryKey: () => ({ after: `-- BigQuery: Cannot declare a primary key. ${NO_PRIMARY_KEY_CONSTRAINT}` }),
    foreignKey: () => ({ after: `-- BigQuery: Cannot add a foreign key. ${NO_FOREIGN_KEY_CONSTRAINT}` }),
  },
  columnDef: standardColumnDef,
  createIndex: () => `-- ${NO_PORTABLE_INDEX_DDL}`,
  dropIndex: () => `-- ${NO_PORTABLE_INDEX_DDL}`,
  addForeignKey: () => `-- BigQuery: Cannot add a foreign key. ${NO_FOREIGN_KEY_CONSTRAINT}`,
  dropForeignKey: () => `-- BigQuery: Cannot drop a foreign key. ${NO_FOREIGN_KEY_CONSTRAINT}`,
  addColumn: standardAddColumn,
  dropColumn: standardDropColumn,
  modifyColumn: (col) => [
    `-- BigQuery: Cannot alter column "${commentName(col.columnName)}". ${NO_COLUMN_MODIFICATION}`,
  ],
  dropTable: standardDropTable,
  reasons: [NO_COLUMN_MODIFICATION, NO_PORTABLE_INDEX_DDL, NO_FOREIGN_KEY_CONSTRAINT, NO_PRIMARY_KEY_CONSTRAINT],
};
