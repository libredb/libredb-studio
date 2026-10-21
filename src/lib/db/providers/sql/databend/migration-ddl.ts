/**
 * Databend has `BEGIN`, `COMMIT` and `ROLLBACK`, but a DDL statement commits the open transaction, so a `BEGIN;`
 * around a migration made of DDL brackets nothing it could roll back, and the migration has no wrapper (the Oracle
 * reason). Its constraints are CHECK only, so it declares no foreign key.
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

export const DATABEND_MIGRATION_DDL: MigrationDdlSpec = {
  tableDdl: "written",
  transactionWrapper: null,
  createTable: {
    kind: "written",
    primaryKey: () => ({ after: `-- Databend: Cannot declare a primary key. ${DATABEND_PRIMARY_KEY_REASON}` }),
    foreignKey: () => ({ after: `-- Databend: Cannot add a foreign key. ${NO_FOREIGN_KEY_CONSTRAINT}` }),
  },
  columnDef: standardColumnDef,
  createIndex: () => `-- ${DATABEND_INDEX_REFUSAL}`,
  dropIndex: () => `-- ${DATABEND_INDEX_REFUSAL}`,
  addForeignKey: () => `-- Databend: Cannot add a foreign key. ${NO_FOREIGN_KEY_CONSTRAINT}`,
  dropForeignKey: () => `-- Databend: Cannot drop a foreign key. ${NO_FOREIGN_KEY_CONSTRAINT}`,
  addColumn: standardAddColumn,
  dropColumn: standardDropColumn,
  modifyColumn: (col) => [
    `-- Databend: Cannot alter column "${commentName(col.columnName)}". ${DATABEND_COLUMN_MODIFICATION_REASON}`,
  ],
  dropTable: standardDropTable,
  reasons: [
    DATABEND_COLUMN_MODIFICATION_REASON,
    DATABEND_INDEX_REFUSAL,
    NO_FOREIGN_KEY_CONSTRAINT,
    DATABEND_PRIMARY_KEY_REASON,
  ],
};
