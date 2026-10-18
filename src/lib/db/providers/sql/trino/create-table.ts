import type { CreateTableSpec } from "@/lib/db/types";

/**
 * The Create Table form's Trino grammar (#1822), kept out of `index.ts` so a test reads it without the transport.
 *
 * Trino declares no primary key in any catalog (the same fact as `supportsInlineRowEdit: false`) and has no sequence
 * object, so no auto-increment; its column grammar is a name, a type and an optional `NOT NULL`, so no `PRIMARY KEY`
 * or `UNIQUE` either. `TEXT` is not a Trino type name; an unbounded string is `VARCHAR`.
 * Measured reasons: `docs/providers/trino.md`, "Create Table form".
 */
export const TRINO_CREATE_TABLE: CreateTableSpec = {
  columnConstraints: false,
  keyType: "INTEGER",
  types: [
    "VARCHAR(255)",
    "VARCHAR",
    "INTEGER",
    "BIGINT",
    "BOOLEAN",
    "TIMESTAMP",
    "DATE",
    "JSON",
    "UUID",
    "DECIMAL(10,2)",
  ],
};
