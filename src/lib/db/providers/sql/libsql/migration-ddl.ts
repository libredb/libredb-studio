/**
 * libSQL is SQLite, so the migration has no wrapper for SQLite's reason (#284), with one addition of its own: this
 * provider closes its Hrana stream in the same request as each statement, so a BEGIN it emitted could not be
 * continued by the app that generated the file.
 *
 * libSQL is a fork of SQLite and declares a foreign key ONLY as a `CREATE TABLE` table constraint, answering
 * identically; the comments still spell out libSQL, because a reader wants the name of the engine they connected
 * to. Measured over Hrana on sqld 0.24.33: `ALTER TABLE "users" ADD CONSTRAINT "fk_users_dept_id" FOREIGN KEY
 * ("dept_id") REFERENCES "departments"("id")` is `near CONSTRAINT ... syntax error`. A created table takes the key
 * inside the statement, and `addForeignKey` declines with a comment (#515).
 */
import {
  commentName,
  standardAddColumn,
  standardColumnDef,
  standardCreateIndex,
  standardDropColumn,
  standardDropIndex,
  standardDropTable,
  standardPrimaryKey,
} from "@/lib/db/migration-ddl/shared";
import type { MigrationDdlSpec } from "@/lib/db/migration-ddl/types";

// Measured over Hrana on sqld 0.24.33, and the reason exists because the PostgreSQL
// branch this id would otherwise inherit emits text libSQL cannot parse:
// `ALTER TABLE t ALTER COLUMN c TYPE integer` is "unexpected end of input" and the
// MySQL spelling `MODIFY COLUMN` is "syntax error around `MODIFY`". No SQLite has a
// column TYPE change, and libSQL is SQLite - unlike DROP COLUMN and RENAME COLUMN,
// which it DOES accept (both measured), so this refusal is narrower than SQLite's
// and deliberately so. Nullability is the one exception and it does not
// reach libSQL: SQLite gained `ALTER COLUMN ... SET/DROP NOT NULL` in 3.53.0 (measured
// 2026-08-27 on 3.53.0 - it rewrites the stored schema and is enforced on insert),
// while sqld 0.24.33 ships 3.47.0, so declining every modification is still right here.
const NO_COLUMN_MODIFICATION = "SQLite cannot retype a column; recreate the table and copy the rows.";

const FOREIGN_KEY_ONLY_IN_CREATE_TABLE =
  "SQLite declares one only in CREATE TABLE; recreate the table and copy the rows.";

const REQUIRES_TABLE_RECREATION = "Requires table recreation.";

export const LIBSQL_MIGRATION_DDL: MigrationDdlSpec = {
  tableDdl: "written",
  transactionWrapper: null,
  createTable: {
    kind: "written",
    primaryKey: standardPrimaryKey,
    foreignKey: (fk) => ({ inside: `,  FOREIGN KEY (${fk.column}) REFERENCES ${fk.references}` }),
  },
  columnDef: standardColumnDef,
  createIndex: standardCreateIndex,
  dropIndex: standardDropIndex,
  addForeignKey: (fk) =>
    `-- libSQL: Cannot add a foreign key on ${commentName(fk.column)}. ${FOREIGN_KEY_ONLY_IN_CREATE_TABLE}`,
  // The standard `DROP CONSTRAINT` is not parseable here, measured on
  // sqld 0.24.33: `ALTER TABLE t DROP CONSTRAINT fk_x` is "near CONSTRAINT …
  // syntax error". Same limit as SQLite, named separately so the comment names
  // the engine the reader connected to.
  dropForeignKey: () => `-- libSQL: Cannot drop a foreign key directly. ${REQUIRES_TABLE_RECREATION}`,
  addColumn: standardAddColumn,
  dropColumn: standardDropColumn,
  modifyColumn: (col) => [`-- libSQL: Cannot alter column "${commentName(col.columnName)}". ${NO_COLUMN_MODIFICATION}`],
  dropTable: standardDropTable,
  reasons: [NO_COLUMN_MODIFICATION, FOREIGN_KEY_ONLY_IN_CREATE_TABLE, REQUIRES_TABLE_RECREATION],
};
