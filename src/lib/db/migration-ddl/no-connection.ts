/**
 * The migration DDL with no connection open: `SchemaDiff.tsx` passed `connection?.type || "postgres"`, so the
 * text is the shared PostgreSQL-shaped statements under a `-- Dialect: postgres` header. Written from `shared.ts`
 * alone rather than from the postgres module, so changing that engine never moves this answer.
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

export const NO_CONNECTION_MIGRATION_DDL: MigrationDdlSpec = {
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
