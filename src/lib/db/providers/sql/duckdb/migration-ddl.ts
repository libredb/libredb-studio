/**
 * DuckDB's own migration DDL functions, each bound by Studio's migration DDL function table
 * (`MIGRATION_DDL_FUNCTIONS` in src/lib/db/migration-ddl/index.ts) at the slot its name gives: DuckDB declares a foreign
 * key ONLY as a `CREATE TABLE` table constraint.
 *
 * Measured on DuckDB v1.5.5, both arms. The table constraint is accepted and readable back - `CREATE TABLE "users"
 * (..., PRIMARY KEY ("id"), FOREIGN KEY ("dept_id") REFERENCES "departments"("id"))` lands, and
 * `duckdb_constraints()` then reports it. The trailing ALTER the other ids get is NOT: `ALTER TABLE t ADD CONSTRAINT
 * fk FOREIGN KEY (a) REFERENCES u(id)` answers "Not implemented Error: No support for that ALTER TABLE option yet!",
 * which is exactly what `addForeignKey` declines to emit. Before the created-table path moved the key inside, the two
 * halves disagreed: the created-table path emitted the very statement the modified-table path documents as refused.
 */
import { commentName } from "@/lib/db/migration-ddl/shared";
import type { TableDdlWritten, WrittenCreateTable } from "@/lib/db/migration-ddl/types";

const FOREIGN_KEY_ONLY_IN_CREATE_TABLE = "ALTER TABLE cannot add one yet; recreate the table and copy the rows.";

const REQUIRES_TABLE_RECREATION = "Requires table recreation.";

export const DUCKDB_CREATE_TABLE_FOREIGN_KEY: WrittenCreateTable["foreignKey"] = (fk) => ({
  inside: `,  FOREIGN KEY (${fk.column}) REFERENCES ${fk.references}`,
});

// A refusal at execution - `ALTER TABLE t ADD CONSTRAINT fk FOREIGN KEY (a) REFERENCES u(id)` parses and then
// answers "Not implemented Error: No support for that ALTER TABLE option yet!" (v1.5.5), as does the UNIQUE form,
// while `ADD CONSTRAINT ... PRIMARY KEY` is the one arm that lands.
export const DUCKDB_ADD_FOREIGN_KEY: TableDdlWritten["addForeignKey"] = (fk) =>
  `-- DuckDB: Cannot add a foreign key on ${commentName(fk.column)}. ${FOREIGN_KEY_ONLY_IN_CREATE_TABLE}`;

// The standard statement is refused here too, measured on v1.5.5: `ALTER
// TABLE t DROP CONSTRAINT IF EXISTS fk_x` is "Not implemented Error: No
// support for that ALTER TABLE option yet!" - and a `Not implemented` is not
// an `IF EXISTS` no-op, so the line would fail a migration rather than skip.
export const DUCKDB_DROP_FOREIGN_KEY: TableDdlWritten["dropForeignKey"] = () =>
  `-- DuckDB: Cannot drop a foreign key directly. ${REQUIRES_TABLE_RECREATION}`;
