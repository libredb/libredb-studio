/**
 * Databend's own migration DDL functions, each bound by Studio's migration DDL function table
 * (`MIGRATION_DDL_FUNCTIONS` in src/lib/db/migration-ddl/index.ts) at the slot its name gives. Its constraints are CHECK
 * only, so it declares no foreign key, its CREATE TABLE declines the primary key in a comment after the statement, and
 * its index and column changes are declined in words.
 */
import { commentName, NO_FOREIGN_KEY_CONSTRAINT } from "@/lib/db/migration-ddl/shared";
import type { TableDdlWritten, WrittenCreateTable } from "@/lib/db/migration-ddl/types";

/**
 * Why a Databend migration names a modified column in a comment rather than altering it (probe L8). Databend HAS
 * `ALTER TABLE ... MODIFY COLUMN`, measured changing type, nullability and comment with the data kept, so the
 * sentence never says otherwise: what it declines is this generator's spelling. The MySQL branch's statement runs on a
 * populated table, but its `NOT NULL` form is refused on an empty one (1058, "Cannot find statistics for column")
 * and a change that does not restate the default drops it; the PostgreSQL branch's `ALTER COLUMN` is a parse error
 * (1005).
 */
const DATABEND_COLUMN_MODIFICATION_REASON =
  "Databend has ALTER TABLE ... MODIFY COLUMN, but the MySQL spelling this generator writes fails NOT NULL on an empty table and silently drops an existing default it does not restate; write the change by hand.";

/** Why an added Databend table declines its key in a comment: probe L11, every `PRIMARY KEY` form is 1005. */
const DATABEND_PRIMARY_KEY_REASON = "Databend's CREATE TABLE has no primary-key constraint.";

/**
 * Databend's index refusal. Its CREATE INDEX always names a kind (INVERTED, NGRAM, VECTOR or SPATIAL search
 * indexes), with no plain or UNIQUE index to carry the diff's column list and uniqueness.
 */
const DATABEND_INDEX_REFUSAL =
  "Databend: Cannot generate index DDL. Its indexes are inverted, ngram, vector and spatial search indexes, which the diff does not record; write the index change by hand.";

export const DATABEND_CREATE_TABLE_PRIMARY_KEY: WrittenCreateTable["primaryKey"] = () => ({
  after: `-- Databend: Cannot declare a primary key. ${DATABEND_PRIMARY_KEY_REASON}`,
});

export const DATABEND_CREATE_TABLE_FOREIGN_KEY: WrittenCreateTable["foreignKey"] = () => ({
  after: `-- Databend: Cannot add a foreign key. ${NO_FOREIGN_KEY_CONSTRAINT}`,
});

export const DATABEND_CREATE_INDEX: TableDdlWritten["createIndex"] = () => `-- ${DATABEND_INDEX_REFUSAL}`;

export const DATABEND_DROP_INDEX: TableDdlWritten["dropIndex"] = () => `-- ${DATABEND_INDEX_REFUSAL}`;

export const DATABEND_ADD_FOREIGN_KEY: TableDdlWritten["addForeignKey"] = () =>
  `-- Databend: Cannot add a foreign key. ${NO_FOREIGN_KEY_CONSTRAINT}`;

export const DATABEND_DROP_FOREIGN_KEY: TableDdlWritten["dropForeignKey"] = () =>
  `-- Databend: Cannot drop a foreign key. ${NO_FOREIGN_KEY_CONSTRAINT}`;

export const DATABEND_MODIFY_COLUMN: TableDdlWritten["modifyColumn"] = (col) => [
  `-- Databend: Cannot alter column "${commentName(col.columnName)}". ${DATABEND_COLUMN_MODIFICATION_REASON}`,
];
