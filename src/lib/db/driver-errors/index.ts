import { DB2_DRIVER_ERRORS } from "@/lib/db/providers/sql/db2/driver-errors";
import { MONGODB_DRIVER_ERRORS } from "@/lib/db/providers/document/mongodb/driver-errors";
import { MSSQL_DRIVER_ERRORS } from "@/lib/db/providers/sql/mssql-driver-errors";
import { MYSQL_DRIVER_ERRORS } from "@/lib/db/providers/sql/mysql-driver-errors";
import { ORACLE_DRIVER_ERRORS } from "@/lib/db/providers/sql/oracle-driver-errors";
import { POSTGRES_DRIVER_ERRORS } from "@/lib/db/providers/sql/postgres-driver-errors";
import { SQLITE_DRIVER_ERRORS } from "@/lib/db/providers/sql/sqlite-driver-errors";
import type { DriverErrorClassifier } from "./types";

/**
 * Every driver's error row, in the one order `mapDatabaseError` asks them: where two rows could both answer one step,
 * the earlier row's answer is the one taken. Each row is declared beside the provider that owns its driver.
 */
export const DRIVER_ERROR_CLASSIFIERS: readonly DriverErrorClassifier[] = Object.freeze([
  MYSQL_DRIVER_ERRORS,
  MSSQL_DRIVER_ERRORS,
  ORACLE_DRIVER_ERRORS,
  DB2_DRIVER_ERRORS,
  MONGODB_DRIVER_ERRORS,
  SQLITE_DRIVER_ERRORS,
  POSTGRES_DRIVER_ERRORS,
]);
