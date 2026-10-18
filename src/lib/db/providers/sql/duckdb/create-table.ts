import type { CreateTableSpec } from "@/lib/db/types";

/**
 * The Create Table form's DuckDB grammar (#1822), kept out of `index.ts` so a test reads it without the native addon.
 *
 * DuckDB 1.5.5 has no `SERIAL`, no identity constraint and no `AUTOINCREMENT`, and no `JSONB` while `JSON` is fine.
 * A sequence works and numbers from 1, so the key defaults from one the form creates first (`sequence`).
 * Measured reasons: `docs/providers/duckdb.md`, "Create Table form".
 */
export const DUCKDB_CREATE_TABLE: CreateTableSpec = {
  autoIncrement: { clause: "INTEGER PRIMARY KEY", sequence: true },
  columnConstraints: true,
  keyType: "INTEGER",
  types: ["VARCHAR(255)", "TEXT", "INTEGER", "BIGINT", "BOOLEAN", "TIMESTAMP", "DATE", "JSON", "UUID", "DECIMAL(10,2)"],
};
