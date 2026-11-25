/**
 * libSQL's own migration DDL functions, each bound by Studio's migration DDL function table
 * (`MIGRATION_DDL_FUNCTIONS` in src/lib/db/migration-ddl/index.ts) at the slot its name gives.
 *
 * libSQL is a fork of SQLite and declares a foreign key ONLY as a `CREATE TABLE` table constraint, answering
 * identically; the comments still spell out libSQL, because a reader wants the name of the engine they connected
 * to. Measured over Hrana on sqld 0.24.33: `ALTER TABLE "users" ADD CONSTRAINT "fk_users_dept_id" FOREIGN KEY
 * ("dept_id") REFERENCES "departments"("id")` is `near CONSTRAINT ... syntax error`. A created table takes the key
 * inside the statement, and `addForeignKey` declines with a comment (#515).
 */
import { commentName } from "@/lib/db/migration-ddl/shared";
import type { TableDdlWritten, WrittenCreateTable } from "@/lib/db/migration-ddl/types";

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

export const LIBSQL_CREATE_TABLE_FOREIGN_KEY: WrittenCreateTable["foreignKey"] = (fk) => ({
  inside: `,  FOREIGN KEY (${fk.column}) REFERENCES ${fk.references}`,
});

export const LIBSQL_ADD_FOREIGN_KEY: TableDdlWritten["addForeignKey"] = (fk) =>
  `-- libSQL: Cannot add a foreign key on ${commentName(fk.column)}. ${FOREIGN_KEY_ONLY_IN_CREATE_TABLE}`;

// The standard `DROP CONSTRAINT` is not parseable here, measured on
// sqld 0.24.33: `ALTER TABLE t DROP CONSTRAINT fk_x` is "near CONSTRAINT …
// syntax error". Same limit as SQLite, named separately so the comment names
// the engine the reader connected to.
export const LIBSQL_DROP_FOREIGN_KEY: TableDdlWritten["dropForeignKey"] = () =>
  `-- libSQL: Cannot drop a foreign key directly. ${REQUIRES_TABLE_RECREATION}`;

export const LIBSQL_MODIFY_COLUMN: TableDdlWritten["modifyColumn"] = (col) => [
  `-- libSQL: Cannot alter column "${commentName(col.columnName)}". ${NO_COLUMN_MODIFICATION}`,
];
