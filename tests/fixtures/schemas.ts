/**
 * The shared object fixture every consumer test draws on (#789).
 *
 * `DetailedObject` rather than the flat `TableSchema` it held before, and each entry
 * carries the two facts the flat shape could not: the `kind` its engine declared and the
 * `path` its segments make up. That is what lets a consumer test exercise a real filter
 * instead of a population nothing declared anything about, where every filter keeps
 * everything and passes whatever it is given.
 *
 * The paths are two-segment and the names are BARE, which is the PostgreSQL shape the join
 * in `src/lib/db/detailed-object.ts` exists for: a reading of the session default container
 * drops the schema from the name it displays and keeps it in the segments.
 */
import type { DetailedObject } from "@/lib/db/detailed-object";

export const mockUsersTable: DetailedObject = {
  name: "users",
  kind: "table",
  path: ["public", "users"],
  columns: [
    { name: "id", type: "integer", nullable: false, isPrimary: true, defaultValue: "nextval('users_id_seq')" },
    { name: "name", type: "varchar(255)", nullable: false, isPrimary: false },
    { name: "email", type: "varchar(255)", nullable: false, isPrimary: false },
    { name: "password", type: "varchar(255)", nullable: false, isPrimary: false },
    { name: "created_at", type: "timestamp", nullable: false, isPrimary: false, defaultValue: "now()" },
    { name: "is_active", type: "boolean", nullable: false, isPrimary: false, defaultValue: "true" },
  ],
  indexes: [
    { name: "users_pkey", columns: ["id"], unique: true },
    { name: "users_email_key", columns: ["email"], unique: true },
  ],
  foreignKeys: [],
  rowCount: 100,
  size: "64 kB",
};

export const mockOrdersTable: DetailedObject = {
  name: "orders",
  kind: "table",
  path: ["public", "orders"],
  columns: [
    { name: "id", type: "integer", nullable: false, isPrimary: true },
    { name: "user_id", type: "integer", nullable: false, isPrimary: false },
    { name: "total", type: "numeric(10,2)", nullable: false, isPrimary: false },
    { name: "status", type: "varchar(50)", nullable: false, isPrimary: false, defaultValue: "'pending'" },
    { name: "created_at", type: "timestamp", nullable: false, isPrimary: false },
  ],
  indexes: [
    { name: "orders_pkey", columns: ["id"], unique: true },
    { name: "orders_user_id_idx", columns: ["user_id"], unique: false },
  ],
  foreignKeys: [{ columnName: "user_id", referencedTable: "users", referencedColumn: "id" }],
  rowCount: 500,
  size: "128 kB",
};

export const mockProductsTable: DetailedObject = {
  name: "products",
  kind: "table",
  path: ["public", "products"],
  columns: [
    { name: "id", type: "integer", nullable: false, isPrimary: true },
    { name: "name", type: "varchar(255)", nullable: false, isPrimary: false },
    { name: "price", type: "numeric(10,2)", nullable: false, isPrimary: false },
    { name: "category", type: "varchar(100)", nullable: true, isPrimary: false },
  ],
  indexes: [{ name: "products_pkey", columns: ["id"], unique: true }],
  foreignKeys: [],
  rowCount: 50,
  size: "32 kB",
};

export const mockSchema: DetailedObject[] = [mockUsersTable, mockOrdersTable, mockProductsTable];

export const emptySchema: DetailedObject[] = [];
