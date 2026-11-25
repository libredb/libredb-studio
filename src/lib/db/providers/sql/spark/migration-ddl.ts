/**
 * Apache Spark's own migration DDL functions, each bound by Studio's migration DDL function table
 * (`MIGRATION_DDL_FUNCTIONS` in src/lib/db/migration-ddl/index.ts) at the slot its name gives: its keys, indexes and
 * column changes are declined in words, each for the reason beside its sentence.
 */
import { commentName } from "@/lib/db/migration-ddl/shared";
import type { TableDdlWritten, WrittenCreateTable } from "@/lib/db/migration-ddl/types";

// Apache Spark: whether a column's type, nullability or default can change is the catalog's and the table format's
// answer, as Trino's is the connector's, and this refusal declines every modified column, whichever of the three the
// diff records. On Spark 4.1.3 and 4.2.0 a session-catalog parquet column's type change fails with
// NOT_SUPPORTED_CHANGE_COLUMN (0A000) while a comment change succeeds; on 4.2.0 the same table refuses SET and DROP
// NOT NULL with UNSUPPORTED_FEATURE.TABLE_OPERATION (0A000) and takes SET and DROP DEFAULT. A DSv2 catalog decides
// for itself.
const NO_COLUMN_MODIFICATION =
  "Whether a column's type, nullability or default can change depends on the catalog and the table format; write the change by hand.";

const NO_PORTABLE_INDEX_DDL =
  "Apache Spark: Cannot generate index DDL. Spark SQL's index statements work only in a catalog whose tables support indexes; write the index change by hand.";

// Spark 4.1 and later parse FOREIGN KEY ... REFERENCES (SPARK-51207) as an informational constraint, NOT ENFORCED
// by default with ENFORCED refused, kept only by a DSv2 catalog that implements constraints. A session-catalog table
// refuses every constraint operation (SPARK-54761): on 4.2.0 a parquet table refuses ADD CONSTRAINT ... FOREIGN KEY,
// with or without NOT ENFORCED, DROP CONSTRAINT and a CREATE TABLE that declares one, each with
// UNSUPPORTED_FEATURE.TABLE_OPERATION (0A000).
const NO_FOREIGN_KEYS =
  "Spark accepts a foreign key only as an informational NOT ENFORCED constraint, in a catalog that implements constraints.";

const NO_PRIMARY_KEY_CONSTRAINT =
  "Spark accepts a primary key only as an informational NOT ENFORCED constraint, in a catalog that implements constraints.";

export const SPARK_CREATE_TABLE_PRIMARY_KEY: WrittenCreateTable["primaryKey"] = () => ({
  after: `-- Apache Spark: Cannot declare a primary key. ${NO_PRIMARY_KEY_CONSTRAINT}`,
});

export const SPARK_CREATE_TABLE_FOREIGN_KEY: WrittenCreateTable["foreignKey"] = () => ({
  after: `-- Apache Spark: Cannot add a foreign key. ${NO_FOREIGN_KEYS}`,
});

export const SPARK_CREATE_INDEX: TableDdlWritten["createIndex"] = () => `-- ${NO_PORTABLE_INDEX_DDL}`;

export const SPARK_DROP_INDEX: TableDdlWritten["dropIndex"] = () => `-- ${NO_PORTABLE_INDEX_DDL}`;

export const SPARK_ADD_FOREIGN_KEY: TableDdlWritten["addForeignKey"] = () =>
  `-- Apache Spark: Cannot add a foreign key. ${NO_FOREIGN_KEYS}`;

export const SPARK_DROP_FOREIGN_KEY: TableDdlWritten["dropForeignKey"] = () =>
  `-- Apache Spark: Cannot drop a foreign key. ${NO_FOREIGN_KEYS}`;

export const SPARK_MODIFY_COLUMN: TableDdlWritten["modifyColumn"] = (col) => [
  `-- Apache Spark: Cannot alter column "${commentName(col.columnName)}". ${NO_COLUMN_MODIFICATION}`,
];
