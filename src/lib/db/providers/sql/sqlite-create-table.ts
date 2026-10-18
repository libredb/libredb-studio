import type { CreateTableSpec } from "@/lib/db/types";

/**
 * The Create Table form's SQLite grammar (#1822), kept out of `sqlite.ts` so a test reads it without a SQLite driver.
 * libSQL embeds SQLite and returns this same object, by import.
 *
 * Only a column typed exactly `INTEGER PRIMARY KEY` is the rowid alias that numbers itself: `SERIAL PRIMARY KEY` is
 * accepted and stores NULL ids, and `AUTOINCREMENT` has one legal position, so the clause is stored whole. SQLite has
 * no JSON, UUID or BOOLEAN type; the names are its five affinities.
 * Measured reasons: `docs/providers/sqlite.md`, "Create Table form".
 */
export const SQLITE_CREATE_TABLE: CreateTableSpec = {
  autoIncrement: { clause: "INTEGER PRIMARY KEY AUTOINCREMENT" },
  columnConstraints: true,
  keyType: "INTEGER",
  types: ["TEXT", "INTEGER", "REAL", "BLOB", "NUMERIC"],
};
