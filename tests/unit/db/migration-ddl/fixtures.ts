/**
 * The fixture behind the migration DDL golden files: one diff that carries every change
 * kind the generator writes, rendered per key with the clock frozen so the
 * `-- Migration generated at` line is stable.
 *
 * The keys are every engine id, then three that are not an engine: `no-connection` (the
 * schema diff panel with no connection open, which today renders as postgres),
 * `constructor` (an inherited Object property name, which a lookup keyed by a plain
 * object would find) and `not-an-engine` (an unknown id).
 */
import { setSystemTime } from "bun:test";
import { EXTERNAL_DATABASE_TYPES } from "@/lib/db/compatibility";
import { generateMigrationSQL } from "@/lib/schema-diff/migration-generator";
import type { SchemaDiff } from "@/lib/schema-diff/types";
import type { DatabaseType } from "@/lib/types";

export const FROZEN_NOW = "2026-10-19T12:00:00.000Z";

export const GOLDEN_KEYS: readonly string[] = [
  ...[...EXTERNAL_DATABASE_TYPES, "libredb"].sort(),
  "no-connection",
  "constructor",
  "not-an-engine",
];

export const FULL_DIFF: SchemaDiff = {
  hasChanges: true,
  summary: { added: 1, removed: 1, modified: 2 },
  tables: [
    {
      action: "removed",
      tableName: "legacy",
      path: ["app", "legacy"],
      columns: [],
      indexes: [],
      foreignKeys: [],
    },
    {
      action: "added",
      tableName: "users",
      path: ["app", "users"],
      columns: [
        {
          action: "added",
          columnName: "id",
          targetType: "integer",
          targetNullable: false,
          targetIsPrimary: true,
          changes: [],
        },
        {
          action: "added",
          columnName: "note",
          targetType: "varchar(20)",
          targetDefault: "abc",
          targetDefaultSql: "'abc'",
          changes: [],
        },
        // No type on either side: the TEXT / VARCHAR2(255) fallback.
        { action: "added", columnName: "bare", changes: [] },
        // A ClickHouse kind prefix in the default.
        { action: "added", columnName: "y", targetType: "Int32", targetDefault: "MATERIALIZED toYear(d)", changes: [] },
        // An empty default is a default.
        { action: "added", columnName: "empty", targetType: "text", targetDefault: "", changes: [] },
      ],
      indexes: [
        // The index that backs the primary key.
        { action: "added", indexName: "users_pkey", targetUnique: true, targetColumns: ["id"], changes: [] },
        { action: "added", indexName: "ix_users_note", targetColumns: ["note"], changes: [] },
      ],
      foreignKeys: [
        {
          action: "added",
          columnName: "dept_id",
          targetReferencedTable: "departments",
          targetReferencedColumn: "id",
          changes: [],
        },
      ],
    },
    {
      action: "modified",
      tableName: "orders",
      path: ["app", "orders"],
      columns: [
        { action: "added", columnName: "extra", targetType: "integer", targetNullable: true, changes: [] },
        { action: "added", columnName: "bare2", changes: [] },
        { action: "removed", columnName: "old", changes: [] },
        {
          action: "modified",
          columnName: "status",
          sourceType: "varchar(10)",
          targetType: "varchar(20)",
          sourceNullable: true,
          targetNullable: false,
          targetDefault: "new",
          targetDefaultSql: "'new'",
          changes: [],
        },
        {
          action: "modified",
          columnName: "amount",
          sourceType: "integer",
          targetType: "integer",
          sourceNullable: false,
          targetNullable: true,
          sourceDefault: "0",
          changes: [],
        },
        {
          action: "modified",
          columnName: "calc",
          sourceType: "Int32",
          targetType: "Int64",
          sourceNullable: true,
          targetNullable: true,
          sourceDefault: "EPHEMERAL 1",
          changes: [],
        },
        {
          action: "modified",
          columnName: "line\nbreak",
          sourceType: "text",
          targetType: "text",
          sourceDefault: "",
          targetDefault: "x",
          changes: [],
        },
      ],
      indexes: [
        { action: "removed", indexName: "ix_old", sourceColumns: ["old"], changes: [] },
        { action: "modified", indexName: "ix_mod", targetUnique: true, targetColumns: ["status"], changes: [] },
        { action: "added", indexName: "ix_new", targetColumns: ["extra", "status"], changes: [] },
      ],
      foreignKeys: [
        { action: "removed", columnName: "customer_id", changes: [] },
        {
          action: "added",
          columnName: "region_id",
          targetReferencedTable: "regions",
          targetReferencedColumn: "id",
          changes: [],
        },
      ],
    },
    // Not a table: named in a comment, never altered.
    {
      action: "modified",
      tableName: "v_orders",
      kind: "view",
      columns: [],
      indexes: [],
      foreignKeys: [],
    },
  ],
};

const NO_CHANGES: SchemaDiff = { tables: [], summary: { added: 0, removed: 0, modified: 0 }, hasChanges: false };

/**
 * The golden text for one key. `no-connection` renders with no dialect at all, which the
 * generator answers with the no-connection spec; every other key is passed as the dialect.
 */
export function renderGolden(key: string): string {
  const dialect = key === "no-connection" ? undefined : (key as DatabaseType);
  setSystemTime(new Date(FROZEN_NOW));
  try {
    return (
      "-- fixture: full\n" +
      generateMigrationSQL(FULL_DIFF, dialect) +
      "\n-- fixture: none\n" +
      generateMigrationSQL(NO_CHANGES, dialect) +
      "\n"
    );
  } finally {
    setSystemTime();
  }
}
