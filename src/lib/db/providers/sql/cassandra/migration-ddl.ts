/**
 * Apache Cassandra has no transaction at all, so the migration has no wrapper (#284) - measured on 5.0.9, `BEGIN;`
 * is "line 1:5 mismatched input ';' expecting K_BATCH" and `COMMIT;` is "no viable alternative at input 'COMMIT'".
 * The only grouping CQL has is `BEGIN BATCH ... APPLY BATCH`, which is not a transaction and takes no DDL, so there
 * is nothing to translate the wrapper INTO - it can only be left out. Cassandra's OTHER statements here were each
 * measured against a live server too, so the wrapper would have been the only unrunnable line in an otherwise
 * runnable migration.
 */
import { commentName, standardCreateIndex, standardDropIndex, standardDropTable } from "@/lib/db/migration-ddl/shared";
import type { MigrationDdlSpec } from "@/lib/db/migration-ddl/types";

/**
 * Why a Cassandra CREATE is refused here rather than emitted.
 *
 * A CQL primary key is two things at once: the partition key, which decides which node holds a row,
 * and the clustering columns, which order rows inside that partition. The brackets carry that
 * distinction and nothing else does. Measured on 5.0.9 with two probe tables that differ only in one
 * pair of them — `probe.composite_pk` is `PRIMARY KEY ((tenant, day), ts)`, `probe.pk_flat` is
 * `PRIMARY KEY (tenant, day, ts)`: `SELECT * FROM probe.pk_flat WHERE tenant = 'a'` is served, while
 * the same restriction on `probe.composite_pk` answers code 2200, "Cannot execute this query as it
 * might involve data filtering and thus may have unpredictable performance". So the two spellings are
 * different tables, not two ways of writing one.
 *
 * `system_schema.columns` distinguishes them by `kind` (`partition_key` vs `clustering`), but
 * `ColumnDiff` keeps only `targetIsPrimary` — both tables above reduce to the same three key columns —
 * so the bracketing is not recoverable from a diff and the shared `PRIMARY KEY (a, b, c)` serializer
 * would silently pick the flat layout. Guessing the physical layout of a table is not a
 * cosmetic error, so this path declines the way the rest of the module declines: a comment naming the
 * limitation, which a human can read, instead of DDL that would run and be wrong.
 *
 * The provider already declares no `createTable` (`sql/cassandra/index.ts`) for the
 * neighbouring reason — what `CreateTableModal` emits is not valid CQL — but `SchemaDiff.tsx` calls
 * the generator with the connection's type and never consults capabilities, so the refusal has to be
 * repeated here or the two contradict each other.
 */
const CASSANDRA_NO_CREATE_TABLE =
  "A CQL primary key splits into a partition key and clustering columns, and a schema diff records neither role, so the partitioning cannot be derived; write the CREATE TABLE by hand.";

// Measured on Cassandra 5.0.9: `ALTER TABLE probe.customers ALTER name TYPE blob`
// answers 8704, "Altering column types is no longer supported" - the operation was
// REMOVED from the engine (it corrupted data), not merely unimplemented. The
// PostgreSQL branch this id would otherwise inherit emits `ALTER COLUMN … TYPE …`,
// which is not even in CQL's ALTER grammar, so there is no statement to emit at all.
const NO_COLUMN_MODIFICATION =
  "Cassandra no longer supports altering a column's type; add a new column and migrate the values, or recreate the table.";

const NO_FOREIGN_KEY_CLAUSE = "The clause is not in CQL's grammar; enforce the relationship in the application.";

const NO_FOREIGN_KEY_TO_DROP = "CQL never declared one.";

export const CASSANDRA_MIGRATION_DDL: MigrationDdlSpec = {
  tableDdl: "written",
  transactionWrapper: null,
  // Declined whole, indexes and foreign keys included: there would be no table for them to attach to.
  createTable: {
    kind: "refused",
    createTableRefusal: (table) =>
      `-- Apache Cassandra: Cannot generate CREATE TABLE for ${commentName(table)}. ${CASSANDRA_NO_CREATE_TABLE}`,
  },
  // A CQL column definition is a name and a type, full stop. Measured on 5.0.9:
  // `name TEXT NOT NULL`, `name TEXT UNIQUE` and `name TEXT DEFAULT 'x'` are each
  // "no viable alternative at input" - none of the three qualifiers exists in the
  // grammar. Nullability is not a column property there (only a primary-key
  // component cannot be null) and there are no defaults at all.
  columnDef: (col, column) => `${column} ${col.targetType || col.sourceType || "TEXT"}`,
  createIndex: standardCreateIndex,
  dropIndex: standardDropIndex,
  // Cassandra has no foreign key to add: `ADD CONSTRAINT ... FOREIGN KEY` is
  // "mismatched input 'FOREIGN' expecting EOF" (measured on 5.0.9), which is also
  // why the provider reports `declaresForeignKeys: false`. This statement exists
  // because that report does not reach the generator: `SchemaDiff.tsx` reads the dialect
  // from the current connection and the diff from a snapshot that may be another
  // connection's, so a relational schema's keys arrive with a CQL dialect.
  addForeignKey: (fk) =>
    `-- Apache Cassandra: Cannot add a foreign key on ${commentName(fk.column)}. ${NO_FOREIGN_KEY_CLAUSE}`,
  // `DROP CONSTRAINT IF EXISTS fk_x` is "mismatched input 'IF' expecting EOF"
  // (measured), and dropping what was never declarable is not a statement.
  dropForeignKey: () => `-- Apache Cassandra: Cannot drop a foreign key. ${NO_FOREIGN_KEY_TO_DROP}`,
  // CQL spells it without the COLUMN keyword, measured on 5.0.9: `ADD COLUMN extra
  // TEXT` is "line 1:42 mismatched input 'TEXT' expecting EOF" while `ADD extra
  // text` succeeds.
  addColumn: (definition, table) => `ALTER TABLE ${table} ADD ${definition};`,
  // Same measurement in the other direction: `DROP COLUMN extra` is "mismatched
  // input 'extra' expecting EOF" on CQL, while `DROP extra` succeeds.
  dropColumn: (_col, column, table) => `ALTER TABLE ${table} DROP ${column};`,
  modifyColumn: (col) => [
    `-- Apache Cassandra: Cannot alter column "${commentName(col.columnName)}". ${NO_COLUMN_MODIFICATION}`,
  ],
  dropTable: standardDropTable,
  reasons: [CASSANDRA_NO_CREATE_TABLE, NO_COLUMN_MODIFICATION, NO_FOREIGN_KEY_CLAUSE, NO_FOREIGN_KEY_TO_DROP],
};
