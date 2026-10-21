/**
 * The migration DDL for a type string that is not a member of the union: the shared PostgreSQL-shaped statements
 * the generator falls through to when no table names the id. Written from `shared.ts` alone, so no engine module
 * moves it.
 */
import {
  BEGIN_COMMIT,
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
import type { MigrationDdlSpec } from "./types";

export const UNKNOWN_TYPE_MIGRATION_DDL: MigrationDdlSpec = {
  tableDdl: "written",
  transactionWrapper: BEGIN_COMMIT,
  createTable: { kind: "written", primaryKey: standardPrimaryKey, foreignKey: standardCreateTableForeignKey },
  columnDef: standardColumnDef,
  createIndex: standardCreateIndex,
  dropIndex: standardDropIndex,
  addForeignKey: standardAddForeignKey,
  dropForeignKey: standardDropForeignKey,
  addColumn: standardAddColumn,
  dropColumn: standardDropColumn,
  modifyColumn: standardModifyColumn,
  dropTable: standardDropTable,
  reasons: [],
};
