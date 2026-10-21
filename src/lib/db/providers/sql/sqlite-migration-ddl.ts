/**
 * SQLite runs its own transaction, so the migration has no wrapper (#284).
 *
 * SQLite's grammar declares a foreign key ONLY as a `CREATE TABLE` table constraint. Its ALTER TABLE page
 * enumerates every schema change the engine has - "rename table", "rename column", "add column", "drop column",
 * plus SET/DROP NOT NULL since 3.53.0 - and adding a constraint is not among them; it routes such a change through
 * its own 12-step table-recreation procedure. Measured on sqlite3 3.53.3: `ALTER TABLE "users" ADD CONSTRAINT
 * "fk_users_dept_id" FOREIGN KEY ("dept_id") REFERENCES "departments"("id")` is `near "FOREIGN": syntax error` - the
 * parser has already taken `CONSTRAINT` for a column name and the quoted name for its type.
 *
 * The two paths answer that fact DIFFERENTLY, which is the point of naming it once (#515). A created table is being
 * built right there, so `createTable.foreignKey` moves the key INSIDE the statement, where SQLite's grammar does take
 * it; `addForeignKey` has no such place to put it and declines with a comment. Declining on both paths would throw
 * away a key the engine can perfectly well hold.
 */
import {
  commentName,
  standardAddColumn,
  standardColumnDef,
  standardCreateIndex,
  standardDropIndex,
  standardDropTable,
  standardPrimaryKey,
} from "@/lib/db/migration-ddl/shared";
import type { MigrationDdlSpec } from "@/lib/db/migration-ddl/types";

const FOREIGN_KEY_ONLY_IN_CREATE_TABLE =
  "A foreign key is declarable only as a CREATE TABLE constraint; recreate the table and copy the rows.";

const REQUIRES_TABLE_RECREATION = "Requires table recreation.";

export const SQLITE_MIGRATION_DDL: MigrationDdlSpec = {
  tableDdl: "written",
  transactionWrapper: null,
  createTable: {
    kind: "written",
    primaryKey: standardPrimaryKey,
    // SQLite's CREATE TABLE takes "one or more column definitions, optionally followed by a list of
    // table constraints", one of which is `FOREIGN KEY ( column-name, ... ) REFERENCES ...`. Hence
    // the position: after the columns AND after the PRIMARY KEY line, never before them - the same
    // constraint placed ahead of a column definition is `near "FOREIGN": syntax error` (measured on
    // sqlite3 3.53.3, where the form below is accepted and `PRAGMA foreign_key_list` then reports the
    // key).
    //
    // The `fk_<table>_<column>` name the other dialects carry is dropped rather than translated into
    // a `CONSTRAINT name` prefix, which SQLite would also accept: the name is this generator's own
    // invention rather than anything the diff recorded, and SQLite never reads a foreign key's name
    // back out - `PRAGMA foreign_key_list` has no name column - so it could only ever be write-only.
    foreignKey: (fk) => ({ inside: `,  FOREIGN KEY (${fk.column}) REFERENCES ${fk.references}` }),
  },
  columnDef: standardColumnDef,
  createIndex: standardCreateIndex,
  dropIndex: standardDropIndex,
  // No ALTER adds a foreign key here, so the honest line names the table recreation instead. Unlike the
  // created-table path, there is nothing to move the key into: the table already exists, and this generator does
  // not write the recreation.
  addForeignKey: (fk) =>
    `-- SQLite: Cannot add a foreign key on ${commentName(fk.column)}. ${FOREIGN_KEY_ONLY_IN_CREATE_TABLE}`,
  dropForeignKey: () => `-- SQLite: Cannot drop foreign key directly. ${REQUIRES_TABLE_RECREATION}`,
  addColumn: standardAddColumn,
  dropColumn: (col) =>
    `-- SQLite: Cannot drop column "${commentName(col.columnName)}" directly. ${REQUIRES_TABLE_RECREATION}`,
  // Declined, and deliberately, though SQLite gained `ALTER COLUMN ... SET/DROP NOT NULL` in 3.53.0: this provider
  // runs on whichever SQLite its runtime bundles - `bun:sqlite` or `node:sqlite`, chosen at runtime with
  // `LIBREDB_SQLITE_DRIVER` as an override - so emitting the statement would write a migration file that succeeds on
  // one deployment and fails on another. A file handed to a human to run elsewhere makes that guess worse than the
  // decline.
  modifyColumn: (col) => [
    `-- SQLite: Cannot alter column "${commentName(col.columnName)}" type directly. ${REQUIRES_TABLE_RECREATION}`,
  ],
  dropTable: standardDropTable,
  reasons: [FOREIGN_KEY_ONLY_IN_CREATE_TABLE, REQUIRES_TABLE_RECREATION],
};
