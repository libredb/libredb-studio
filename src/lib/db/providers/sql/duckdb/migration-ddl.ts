/**
 * DuckDB writes the shared statements wrapped in `BEGIN;` and `COMMIT;`, except for foreign keys, which it declares
 * ONLY as a `CREATE TABLE` table constraint.
 *
 * Measured on DuckDB v1.5.5, both arms. The table constraint is accepted and readable back - `CREATE TABLE "users"
 * (..., PRIMARY KEY ("id"), FOREIGN KEY ("dept_id") REFERENCES "departments"("id"))` lands, and
 * `duckdb_constraints()` then reports it. The trailing ALTER the other ids get is NOT: `ALTER TABLE t ADD CONSTRAINT
 * fk FOREIGN KEY (a) REFERENCES u(id)` answers "Not implemented Error: No support for that ALTER TABLE option yet!",
 * which is exactly what `addForeignKey` declines to emit. Before the created-table path moved the key inside, the two
 * halves disagreed: the created-table path emitted the very statement the modified-table path documents as refused.
 */
import {
  BEGIN_COMMIT,
  commentName,
  standardAddColumn,
  standardColumnDef,
  standardCreateIndex,
  standardDropColumn,
  standardDropIndex,
  standardDropTable,
  standardModifyColumn,
  standardPrimaryKey,
} from "@/lib/db/migration-ddl/shared";
import type { MigrationDdlSpec } from "@/lib/db/migration-ddl/types";

const FOREIGN_KEY_ONLY_IN_CREATE_TABLE = "ALTER TABLE cannot add one yet; recreate the table and copy the rows.";

const REQUIRES_TABLE_RECREATION = "Requires table recreation.";

export const DUCKDB_MIGRATION_DDL: MigrationDdlSpec = {
  tableDdl: "written",
  transactionWrapper: BEGIN_COMMIT,
  createTable: {
    kind: "written",
    primaryKey: standardPrimaryKey,
    foreignKey: (fk) => ({ inside: `,  FOREIGN KEY (${fk.column}) REFERENCES ${fk.references}` }),
  },
  columnDef: standardColumnDef,
  createIndex: standardCreateIndex,
  dropIndex: standardDropIndex,
  // A refusal at execution - `ALTER TABLE t ADD CONSTRAINT fk FOREIGN KEY (a) REFERENCES u(id)` parses and then
  // answers "Not implemented Error: No support for that ALTER TABLE option yet!" (v1.5.5), as does the UNIQUE form,
  // while `ADD CONSTRAINT ... PRIMARY KEY` is the one arm that lands.
  addForeignKey: (fk) =>
    `-- DuckDB: Cannot add a foreign key on ${commentName(fk.column)}. ${FOREIGN_KEY_ONLY_IN_CREATE_TABLE}`,
  // The standard statement is refused here too, measured on v1.5.5: `ALTER
  // TABLE t DROP CONSTRAINT IF EXISTS fk_x` is "Not implemented Error: No
  // support for that ALTER TABLE option yet!" - and a `Not implemented` is not
  // an `IF EXISTS` no-op, so the line would fail a migration rather than skip.
  dropForeignKey: () => `-- DuckDB: Cannot drop a foreign key directly. ${REQUIRES_TABLE_RECREATION}`,
  addColumn: standardAddColumn,
  dropColumn: standardDropColumn,
  modifyColumn: standardModifyColumn,
  dropTable: standardDropTable,
  reasons: [FOREIGN_KEY_ONLY_IN_CREATE_TABLE, REQUIRES_TABLE_RECREATION],
};
