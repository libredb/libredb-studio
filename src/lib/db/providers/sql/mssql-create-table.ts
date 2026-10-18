import type { CreateTableSpec } from "@/lib/db/types";

/**
 * The Create Table form's SQL Server grammar (#1822), kept out of `mssql.ts` so a test reads it without `mssql`.
 *
 * No `BOOLEAN` (that is `BIT`) and no `UUID` (`UNIQUEIDENTIFIER`); `TIMESTAMP` is a deprecated synonym for
 * `ROWVERSION`, which holds no date, so a moment in time is `DATETIME2`. JSON is stored in `NVARCHAR(MAX)`: the native
 * `json` type is SQL Server 2025 and this repo's compose pins 2022. `keyType` is `INT`, the name the list holds.
 * Measured reasons: `docs/providers/mssql.md`, "Create Table form".
 */
export const MSSQL_CREATE_TABLE: CreateTableSpec = {
  autoIncrement: { clause: "INT IDENTITY(1,1) PRIMARY KEY" },
  columnConstraints: true,
  keyType: "INT",
  types: [
    "VARCHAR(255)",
    "NVARCHAR(MAX)",
    "INT",
    "BIGINT",
    "BIT",
    "DATETIME2",
    "DATE",
    "UNIQUEIDENTIFIER",
    "DECIMAL(10,2)",
  ],
};
