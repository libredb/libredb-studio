/**
 * Every engine's migration DDL row, one per type id, composed when this module loads (docs/providers/CONTRACT.md,
 * clause M-80) from two sources:
 *
 * - the migration DDL each engine's declaration authors, its whole `migrationDdl` segment, projected into
 *   src/lib/db/engine-catalog/migration-ddl.generated.ts as `BUNDLED_MIGRATION_DDL`;
 * - Studio's migration DDL function table, `MIGRATION_DDL_FUNCTIONS`, which binds each function name a declaration
 *   gives to the function Studio's own source holds for that engine at that slot.
 *
 * A refused form is its refusal line, no wrapper and its reasons, and names no function; a written form is its
 * transaction wrapper, its CREATE TABLE form and its nine statement writers, each bound through the table. A
 * declaration's migration DDL facts and the names of its functions are therefore edited in its file under
 * src/lib/db/engine-declarations and regenerated with `bun run engines:generate`; a function an engine needs of its own
 * is added to `MIGRATION_DDL_FUNCTIONS`, from a module beside its provider.
 */
import { BUNDLED_MIGRATION_DDL } from "@/lib/db/engine-catalog/migration-ddl.generated";
import type { MigrationDdlEntry } from "@/lib/db/engine-catalog/projection";
import { boundFunction, type FunctionTable, slotFunctionTable } from "@/lib/db/function-table";
import {
  BIGQUERY_ADD_FOREIGN_KEY,
  BIGQUERY_CREATE_INDEX,
  BIGQUERY_CREATE_TABLE_FOREIGN_KEY,
  BIGQUERY_CREATE_TABLE_PRIMARY_KEY,
  BIGQUERY_DROP_FOREIGN_KEY,
  BIGQUERY_DROP_INDEX,
  BIGQUERY_MODIFY_COLUMN,
} from "@/lib/db/providers/sql/bigquery/migration-ddl";
import {
  CASSANDRA_ADD_COLUMN,
  CASSANDRA_ADD_FOREIGN_KEY,
  CASSANDRA_COLUMN_DEF,
  CASSANDRA_CREATE_TABLE_REFUSAL,
  CASSANDRA_DROP_COLUMN,
  CASSANDRA_DROP_FOREIGN_KEY,
  CASSANDRA_MODIFY_COLUMN,
} from "@/lib/db/providers/sql/cassandra/migration-ddl";
import {
  CLICKHOUSE_ADD_FOREIGN_KEY,
  CLICKHOUSE_COLUMN_DEF,
  CLICKHOUSE_CREATE_INDEX,
  CLICKHOUSE_CREATE_TABLE_FOREIGN_KEY,
  CLICKHOUSE_DROP_FOREIGN_KEY,
  CLICKHOUSE_DROP_INDEX,
  CLICKHOUSE_MODIFY_COLUMN,
} from "@/lib/db/providers/sql/clickhouse/migration-ddl";
import {
  DATABEND_ADD_FOREIGN_KEY,
  DATABEND_CREATE_INDEX,
  DATABEND_CREATE_TABLE_FOREIGN_KEY,
  DATABEND_CREATE_TABLE_PRIMARY_KEY,
  DATABEND_DROP_FOREIGN_KEY,
  DATABEND_DROP_INDEX,
  DATABEND_MODIFY_COLUMN,
} from "@/lib/db/providers/sql/databend/migration-ddl";
import { DB2_DROP_FOREIGN_KEY, DB2_DROP_INDEX, DB2_MODIFY_COLUMN } from "@/lib/db/providers/sql/db2/migration-ddl";
import {
  DUCKDB_ADD_FOREIGN_KEY,
  DUCKDB_CREATE_TABLE_FOREIGN_KEY,
  DUCKDB_DROP_FOREIGN_KEY,
} from "@/lib/db/providers/sql/duckdb/migration-ddl";
import {
  LIBSQL_ADD_FOREIGN_KEY,
  LIBSQL_CREATE_TABLE_FOREIGN_KEY,
  LIBSQL_DROP_FOREIGN_KEY,
  LIBSQL_MODIFY_COLUMN,
} from "@/lib/db/providers/sql/libsql/migration-ddl";
import { MSSQL_ADD_COLUMN, MSSQL_DROP_INDEX, MSSQL_MODIFY_COLUMN } from "@/lib/db/providers/sql/mssql-migration-ddl";
import {
  MYSQL_DROP_FOREIGN_KEY,
  MYSQL_DROP_INDEX,
  MYSQL_MODIFY_COLUMN,
} from "@/lib/db/providers/sql/mysql-migration-ddl";
import {
  ORACLE_ADD_COLUMN,
  ORACLE_COLUMN_DEF,
  ORACLE_DROP_FOREIGN_KEY,
  ORACLE_DROP_INDEX,
  ORACLE_DROP_TABLE,
  ORACLE_MODIFY_COLUMN,
} from "@/lib/db/providers/sql/oracle-migration-ddl";
import {
  SNOWFLAKE_CREATE_INDEX,
  SNOWFLAKE_DROP_INDEX,
  SNOWFLAKE_MODIFY_COLUMN,
} from "@/lib/db/providers/sql/snowflake/migration-ddl";
import {
  SPARK_ADD_FOREIGN_KEY,
  SPARK_CREATE_INDEX,
  SPARK_CREATE_TABLE_FOREIGN_KEY,
  SPARK_CREATE_TABLE_PRIMARY_KEY,
  SPARK_DROP_FOREIGN_KEY,
  SPARK_DROP_INDEX,
  SPARK_MODIFY_COLUMN,
} from "@/lib/db/providers/sql/spark/migration-ddl";
import {
  SQLITE_ADD_FOREIGN_KEY,
  SQLITE_CREATE_TABLE_FOREIGN_KEY,
  SQLITE_DROP_COLUMN,
  SQLITE_DROP_FOREIGN_KEY,
  SQLITE_MODIFY_COLUMN,
} from "@/lib/db/providers/sql/sqlite-migration-ddl";
import {
  TRINO_ADD_FOREIGN_KEY,
  TRINO_CREATE_INDEX,
  TRINO_CREATE_TABLE_FOREIGN_KEY,
  TRINO_CREATE_TABLE_PRIMARY_KEY,
  TRINO_DROP_FOREIGN_KEY,
  TRINO_DROP_INDEX,
  TRINO_MODIFY_COLUMN,
} from "@/lib/db/providers/sql/trino/migration-ddl";
import { DEFAULT_CONNECTION_TYPE } from "@/lib/db/default-connection-type";
import { assertDatabaseType, typeIdRow } from "@/lib/db/type-id";
import type { DatabaseType } from "@/lib/types";
import { NO_CONNECTION_MIGRATION_DDL } from "./no-connection";
import {
  standardAddColumn,
  standardAddForeignKey,
  standardColumnDef,
  standardCreateIndex,
  standardCreateTableForeignKey,
  standardDropColumn,
  standardDropForeignKey,
  standardDropIndex,
  standardDropTable,
  standardModifyColumn,
  standardPrimaryKey,
} from "./shared";
import type {
  CreateTableDdl,
  MigrationDdlSpec,
  RefusedCreateTable,
  TableDdlWritten,
  WrittenCreateTable,
} from "./types";

/**
 * Studio's migration DDL function table: for each slot kind a declaration names a function at, the functions Studio's
 * own source holds, per engine and name. A name is bound only at its own kind, so a drop writer is never run as a
 * create writer.
 */
export interface MigrationDdlFunctions {
  /** `createTable.primaryKey`: a written CREATE TABLE's primary key, from the quoted key columns. */
  readonly createTablePrimaryKeys: FunctionTable<WrittenCreateTable["primaryKey"]>;
  /** `createTable.foreignKey`: a written CREATE TABLE's foreign key, from the quoted parts. */
  readonly createTableForeignKeys: FunctionTable<WrittenCreateTable["foreignKey"]>;
  /** `createTable.createTableRefusal`: the line a refused CREATE TABLE writes in its place. */
  readonly createTableRefusals: FunctionTable<RefusedCreateTable["createTableRefusal"]>;
  /** `columnDef`: one column's definition. */
  readonly columnDefs: FunctionTable<TableDdlWritten["columnDef"]>;
  /** `createIndex`: an index's CREATE. */
  readonly createIndexes: FunctionTable<TableDdlWritten["createIndex"]>;
  /** `dropIndex`: an index's DROP. */
  readonly dropIndexes: FunctionTable<TableDdlWritten["dropIndex"]>;
  /** `addForeignKey`: a foreign key added to a table. */
  readonly addForeignKeys: FunctionTable<TableDdlWritten["addForeignKey"]>;
  /** `dropForeignKey`: a foreign key dropped from a table. */
  readonly dropForeignKeys: FunctionTable<TableDdlWritten["dropForeignKey"]>;
  /** `addColumn`: a column added. */
  readonly addColumns: FunctionTable<TableDdlWritten["addColumn"]>;
  /** `dropColumn`: a column dropped. */
  readonly dropColumns: FunctionTable<TableDdlWritten["dropColumn"]>;
  /** `modifyColumn`: a column changed, as one statement or several. */
  readonly modifyColumns: FunctionTable<TableDdlWritten["modifyColumn"]>;
  /** `dropTable`: a table dropped. */
  readonly dropTables: FunctionTable<TableDdlWritten["dropTable"]>;
}

/**
 * The functions the committed declarations name, each the one Studio's source holds for that engine at that slot: 92
 * of them a building block of ./shared.ts, and 72 an engine's own, from the module beside its provider. Every
 * declaration names each function by its slot's own name (clause M-31), so each kind is built by `slotFunctionTable`,
 * and tests/unit/db/migration-ddl/compose.test.ts holds the table to exactly the names the committed declarations give.
 *
 * Every migration DDL function runs in the browser, in the schema diff panel, so only Studio's own functions are bound
 * here: a name this table does not hold, a package's included, is refused when the row is composed. Whether a
 * declaration may choose a shared building block by name, and where a package's own migration DDL function runs, are
 * decided with the first package that fills a slot (clause S-19).
 */
export const MIGRATION_DDL_FUNCTIONS: MigrationDdlFunctions = Object.freeze({
  createTablePrimaryKeys: slotFunctionTable("createTablePrimaryKey", {
    bigquery: BIGQUERY_CREATE_TABLE_PRIMARY_KEY,
    clickhouse: standardPrimaryKey,
    databend: DATABEND_CREATE_TABLE_PRIMARY_KEY,
    db2: standardPrimaryKey,
    duckdb: standardPrimaryKey,
    libsql: standardPrimaryKey,
    mssql: standardPrimaryKey,
    mysql: standardPrimaryKey,
    oracle: standardPrimaryKey,
    postgres: standardPrimaryKey,
    snowflake: standardPrimaryKey,
    spark: SPARK_CREATE_TABLE_PRIMARY_KEY,
    sqlite: standardPrimaryKey,
    trino: TRINO_CREATE_TABLE_PRIMARY_KEY,
  }),
  createTableForeignKeys: slotFunctionTable("createTableForeignKey", {
    bigquery: BIGQUERY_CREATE_TABLE_FOREIGN_KEY,
    clickhouse: CLICKHOUSE_CREATE_TABLE_FOREIGN_KEY,
    databend: DATABEND_CREATE_TABLE_FOREIGN_KEY,
    db2: standardCreateTableForeignKey,
    duckdb: DUCKDB_CREATE_TABLE_FOREIGN_KEY,
    libsql: LIBSQL_CREATE_TABLE_FOREIGN_KEY,
    mssql: standardCreateTableForeignKey,
    mysql: standardCreateTableForeignKey,
    oracle: standardCreateTableForeignKey,
    postgres: standardCreateTableForeignKey,
    snowflake: standardCreateTableForeignKey,
    spark: SPARK_CREATE_TABLE_FOREIGN_KEY,
    sqlite: SQLITE_CREATE_TABLE_FOREIGN_KEY,
    trino: TRINO_CREATE_TABLE_FOREIGN_KEY,
  }),
  createTableRefusals: slotFunctionTable("createTableRefusal", {
    cassandra: CASSANDRA_CREATE_TABLE_REFUSAL,
  }),
  columnDefs: slotFunctionTable("columnDef", {
    bigquery: standardColumnDef,
    cassandra: CASSANDRA_COLUMN_DEF,
    clickhouse: CLICKHOUSE_COLUMN_DEF,
    databend: standardColumnDef,
    db2: standardColumnDef,
    duckdb: standardColumnDef,
    libsql: standardColumnDef,
    mssql: standardColumnDef,
    mysql: standardColumnDef,
    oracle: ORACLE_COLUMN_DEF,
    postgres: standardColumnDef,
    snowflake: standardColumnDef,
    spark: standardColumnDef,
    sqlite: standardColumnDef,
    trino: standardColumnDef,
  }),
  createIndexes: slotFunctionTable("createIndex", {
    bigquery: BIGQUERY_CREATE_INDEX,
    cassandra: standardCreateIndex,
    clickhouse: CLICKHOUSE_CREATE_INDEX,
    databend: DATABEND_CREATE_INDEX,
    db2: standardCreateIndex,
    duckdb: standardCreateIndex,
    libsql: standardCreateIndex,
    mssql: standardCreateIndex,
    mysql: standardCreateIndex,
    oracle: standardCreateIndex,
    postgres: standardCreateIndex,
    snowflake: SNOWFLAKE_CREATE_INDEX,
    spark: SPARK_CREATE_INDEX,
    sqlite: standardCreateIndex,
    trino: TRINO_CREATE_INDEX,
  }),
  dropIndexes: slotFunctionTable("dropIndex", {
    bigquery: BIGQUERY_DROP_INDEX,
    cassandra: standardDropIndex,
    clickhouse: CLICKHOUSE_DROP_INDEX,
    databend: DATABEND_DROP_INDEX,
    db2: DB2_DROP_INDEX,
    duckdb: standardDropIndex,
    libsql: standardDropIndex,
    mssql: MSSQL_DROP_INDEX,
    mysql: MYSQL_DROP_INDEX,
    oracle: ORACLE_DROP_INDEX,
    postgres: standardDropIndex,
    snowflake: SNOWFLAKE_DROP_INDEX,
    spark: SPARK_DROP_INDEX,
    sqlite: standardDropIndex,
    trino: TRINO_DROP_INDEX,
  }),
  addForeignKeys: slotFunctionTable("addForeignKey", {
    bigquery: BIGQUERY_ADD_FOREIGN_KEY,
    cassandra: CASSANDRA_ADD_FOREIGN_KEY,
    clickhouse: CLICKHOUSE_ADD_FOREIGN_KEY,
    databend: DATABEND_ADD_FOREIGN_KEY,
    db2: standardAddForeignKey,
    duckdb: DUCKDB_ADD_FOREIGN_KEY,
    libsql: LIBSQL_ADD_FOREIGN_KEY,
    mssql: standardAddForeignKey,
    mysql: standardAddForeignKey,
    oracle: standardAddForeignKey,
    postgres: standardAddForeignKey,
    snowflake: standardAddForeignKey,
    spark: SPARK_ADD_FOREIGN_KEY,
    sqlite: SQLITE_ADD_FOREIGN_KEY,
    trino: TRINO_ADD_FOREIGN_KEY,
  }),
  dropForeignKeys: slotFunctionTable("dropForeignKey", {
    bigquery: BIGQUERY_DROP_FOREIGN_KEY,
    cassandra: CASSANDRA_DROP_FOREIGN_KEY,
    clickhouse: CLICKHOUSE_DROP_FOREIGN_KEY,
    databend: DATABEND_DROP_FOREIGN_KEY,
    db2: DB2_DROP_FOREIGN_KEY,
    duckdb: DUCKDB_DROP_FOREIGN_KEY,
    libsql: LIBSQL_DROP_FOREIGN_KEY,
    mssql: standardDropForeignKey,
    mysql: MYSQL_DROP_FOREIGN_KEY,
    oracle: ORACLE_DROP_FOREIGN_KEY,
    postgres: standardDropForeignKey,
    snowflake: standardDropForeignKey,
    spark: SPARK_DROP_FOREIGN_KEY,
    sqlite: SQLITE_DROP_FOREIGN_KEY,
    trino: TRINO_DROP_FOREIGN_KEY,
  }),
  addColumns: slotFunctionTable("addColumn", {
    bigquery: standardAddColumn,
    cassandra: CASSANDRA_ADD_COLUMN,
    clickhouse: standardAddColumn,
    databend: standardAddColumn,
    db2: standardAddColumn,
    duckdb: standardAddColumn,
    libsql: standardAddColumn,
    mssql: MSSQL_ADD_COLUMN,
    mysql: standardAddColumn,
    oracle: ORACLE_ADD_COLUMN,
    postgres: standardAddColumn,
    snowflake: standardAddColumn,
    spark: standardAddColumn,
    sqlite: standardAddColumn,
    trino: standardAddColumn,
  }),
  dropColumns: slotFunctionTable("dropColumn", {
    bigquery: standardDropColumn,
    cassandra: CASSANDRA_DROP_COLUMN,
    clickhouse: standardDropColumn,
    databend: standardDropColumn,
    db2: standardDropColumn,
    duckdb: standardDropColumn,
    libsql: standardDropColumn,
    mssql: standardDropColumn,
    mysql: standardDropColumn,
    oracle: standardDropColumn,
    postgres: standardDropColumn,
    snowflake: standardDropColumn,
    spark: standardDropColumn,
    sqlite: SQLITE_DROP_COLUMN,
    trino: standardDropColumn,
  }),
  modifyColumns: slotFunctionTable("modifyColumn", {
    bigquery: BIGQUERY_MODIFY_COLUMN,
    cassandra: CASSANDRA_MODIFY_COLUMN,
    clickhouse: CLICKHOUSE_MODIFY_COLUMN,
    databend: DATABEND_MODIFY_COLUMN,
    db2: DB2_MODIFY_COLUMN,
    duckdb: standardModifyColumn,
    libsql: LIBSQL_MODIFY_COLUMN,
    mssql: MSSQL_MODIFY_COLUMN,
    mysql: MYSQL_MODIFY_COLUMN,
    oracle: ORACLE_MODIFY_COLUMN,
    postgres: standardModifyColumn,
    snowflake: SNOWFLAKE_MODIFY_COLUMN,
    spark: SPARK_MODIFY_COLUMN,
    sqlite: SQLITE_MODIFY_COLUMN,
    trino: TRINO_MODIFY_COLUMN,
  }),
  dropTables: slotFunctionTable("dropTable", {
    bigquery: standardDropTable,
    cassandra: standardDropTable,
    clickhouse: standardDropTable,
    databend: standardDropTable,
    db2: standardDropTable,
    duckdb: standardDropTable,
    libsql: standardDropTable,
    mssql: standardDropTable,
    mysql: standardDropTable,
    oracle: ORACLE_DROP_TABLE,
    postgres: standardDropTable,
    snowflake: standardDropTable,
    spark: standardDropTable,
    sqlite: standardDropTable,
    trino: standardDropTable,
  }),
});

type WrittenEntry = Extract<MigrationDdlEntry, { readonly tableDdl: "written" }>;

/** The CREATE TABLE form `createTable` declares: its key writers bound, or its refusal line's writer bound. */
function createTableOf(
  id: DatabaseType,
  createTable: WrittenEntry["createTable"],
  functions: MigrationDdlFunctions,
): CreateTableDdl {
  if (createTable.kind === "refused") {
    return Object.freeze({
      kind: "refused",
      createTableRefusal: boundFunction(id, functions.createTableRefusals, createTable.createTableRefusal),
    });
  }
  return Object.freeze({
    kind: "written",
    primaryKey: boundFunction(id, functions.createTablePrimaryKeys, createTable.primaryKey),
    foreignKey: boundFunction(id, functions.createTableForeignKeys, createTable.foreignKey),
  });
}

/**
 * The written row `entry` declares: its wrapper a frozen `{ begin, commit }` or null, its CREATE TABLE by
 * `createTableOf`, its nine writers bound through `functions`, and its reasons a frozen copy in their order.
 */
function writtenOf(id: DatabaseType, entry: WrittenEntry, functions: MigrationDdlFunctions): TableDdlWritten {
  const wrapper = entry.transactionWrapper;
  return Object.freeze({
    tableDdl: "written",
    transactionWrapper: wrapper === null ? null : Object.freeze({ begin: wrapper.begin, commit: wrapper.commit }),
    createTable: createTableOf(id, entry.createTable, functions),
    columnDef: boundFunction(id, functions.columnDefs, entry.columnDef),
    createIndex: boundFunction(id, functions.createIndexes, entry.createIndex),
    dropIndex: boundFunction(id, functions.dropIndexes, entry.dropIndex),
    addForeignKey: boundFunction(id, functions.addForeignKeys, entry.addForeignKey),
    dropForeignKey: boundFunction(id, functions.dropForeignKeys, entry.dropForeignKey),
    addColumn: boundFunction(id, functions.addColumns, entry.addColumn),
    dropColumn: boundFunction(id, functions.dropColumns, entry.dropColumn),
    modifyColumn: boundFunction(id, functions.modifyColumns, entry.modifyColumn),
    dropTable: boundFunction(id, functions.dropTables, entry.dropTable),
    reasons: Object.freeze([...entry.reasons]),
  });
}

/**
 * Engine `id`'s migration DDL row, composed from `entry`, its projected migration DDL, and `functions`: a refused form
 * as its refusal line, no wrapper and a frozen copy of its reasons, naming no function; a written form by `writtenOf`.
 * The row and every record in it are frozen.
 *
 * @throws {Error} Naming the engine and the name, for a function name `functions` holds none for at its slot, a name it
 * holds only at another slot included.
 */
export function composeMigrationDdl(
  id: DatabaseType,
  entry: MigrationDdlEntry,
  functions: MigrationDdlFunctions,
): MigrationDdlSpec {
  if (entry.tableDdl === "refused") {
    return Object.freeze({
      tableDdl: "refused",
      refusal: entry.refusal,
      transactionWrapper: null,
      reasons: Object.freeze([...entry.reasons]),
    });
  }
  return writtenOf(id, entry, functions);
}

/**
 * Every engine's migration DDL row, composed when this module loads from `BUNDLED_MIGRATION_DDL` and Studio's migration
 * DDL function table, so a committed module naming a function Studio holds none for fails every importer by that
 * sentence. Keyed in the projection's ascending id order, and total over `DatabaseType`, since the generated record is
 * typed over it: a new id without a declaration is a compile error there.
 */
export const MIGRATION_DDL: Readonly<Record<DatabaseType, MigrationDdlSpec>> = Object.freeze(
  Object.fromEntries(
    (Object.keys(BUNDLED_MIGRATION_DDL) as DatabaseType[]).map((id) => [
      id,
      composeMigrationDdl(id, BUNDLED_MIGRATION_DDL[id], MIGRATION_DDL_FUNCTIONS),
    ]),
  ) as Record<DatabaseType, MigrationDdlSpec>,
);

/**
 * The spec for a connection's type: `undefined` (no connection) gives the no-connection spec, and a type id its row,
 * read through `typeIdRow`, so any other value is refused by name and `"constructor"` is never read as a row.
 *
 * @throws {UnknownProviderError} When `type` is defined and not a type id: a string that names no provider, `""`,
 * `null`, or a value that is not text.
 */
export function migrationDdlFor(type: string | undefined): MigrationDdlSpec {
  if (type === undefined) return NO_CONNECTION_MIGRATION_DDL;
  return typeIdRow(MIGRATION_DDL, type);
}

/**
 * The word the migration's `-- Dialect:` header prints: the default connection type for `undefined`, which is what
 * `SchemaDiff.tsx` passed with no connection open, and the type id as given otherwise, so the generator holds no
 * type id of its own.
 *
 * @throws {UnknownProviderError} When `type` is defined and not a type id: a string that names no provider, `""`,
 * `null`, or a value that is not text.
 */
export function migrationDialectHeader(type: string | undefined): string {
  if (type !== undefined) assertDatabaseType(type);
  return type === undefined ? DEFAULT_CONNECTION_TYPE : type;
}
