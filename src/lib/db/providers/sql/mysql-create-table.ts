import type { CreateTableSpec } from "@/lib/db/types";

/**
 * The Create Table form's MySQL grammar (#1822), kept out of `mysql.ts` so a test reads it without `mysql2`.
 *
 * `JSON` since 5.7, and no `UUID` type: the docs' own recommendation for one is a fixed-width `CHAR(36)` (or
 * `BINARY(16)` via `UUID_TO_BIN`). `keyType` is `INT`, the name the list holds, so the dropdown trigger is not empty.
 * Measured reasons: `docs/providers/mysql.md`, "Create Table form".
 */
export const MYSQL_CREATE_TABLE: CreateTableSpec = {
  autoIncrement: { clause: "INT AUTO_INCREMENT PRIMARY KEY" },
  columnConstraints: true,
  keyType: "INT",
  types: ["VARCHAR(255)", "TEXT", "INT", "BIGINT", "BOOLEAN", "TIMESTAMP", "DATE", "JSON", "CHAR(36)", "DECIMAL(10,2)"],
};
