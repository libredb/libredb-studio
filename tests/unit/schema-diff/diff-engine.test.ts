import { describe, test, expect } from "bun:test";
import { diffSchemas } from "@/lib/schema-diff/diff-engine";
import type { DetailedObject } from "@/lib/db/detailed-object";

// ============================================================================
// Helpers
// ============================================================================

function makeTable(overrides: Partial<DetailedObject> & { name: string }): DetailedObject {
  return {
    columns: [],
    indexes: [],
    foreignKeys: [],
    ...overrides,
  };
}

// ============================================================================
// Basic scenarios
// ============================================================================

describe("diffSchemas: basic", () => {
  test("identical schemas produce no changes", () => {
    const schema: DetailedObject[] = [
      makeTable({
        name: "users",
        columns: [{ name: "id", type: "integer", nullable: false, isPrimary: true }],
        indexes: [{ name: "users_pkey", columns: ["id"], unique: true }],
      }),
    ];
    const result = diffSchemas(schema, schema);
    expect(result.hasChanges).toBe(false);
    expect(result.tables).toEqual([]);
    expect(result.summary).toEqual({ added: 0, removed: 0, modified: 0 });
  });

  test("empty source and target produce no changes", () => {
    const result = diffSchemas([], []);
    expect(result.hasChanges).toBe(false);
    expect(result.tables.length).toBe(0);
  });
});

// ============================================================================
// Added tables
// ============================================================================

describe("diffSchemas: added tables", () => {
  test("table in target but not source is marked added", () => {
    const target: DetailedObject[] = [
      makeTable({
        name: "orders",
        columns: [
          { name: "id", type: "integer", nullable: false, isPrimary: true },
          { name: "total", type: "numeric", nullable: false, isPrimary: false },
        ],
        indexes: [{ name: "orders_pkey", columns: ["id"], unique: true }],
      }),
    ];
    const result = diffSchemas([], target);
    expect(result.hasChanges).toBe(true);
    expect(result.summary.added).toBe(1);
    expect(result.tables[0].action).toBe("added");
    expect(result.tables[0].tableName).toBe("orders");
    expect(result.tables[0].columns.length).toBe(2);
    expect(result.tables[0].columns.every((c) => c.action === "added")).toBe(true);
  });

  test("added table includes indexes as added", () => {
    const target: DetailedObject[] = [
      makeTable({
        name: "orders",
        columns: [{ name: "id", type: "integer", nullable: false, isPrimary: true }],
        indexes: [{ name: "orders_pkey", columns: ["id"], unique: true }],
      }),
    ];
    const result = diffSchemas([], target);
    expect(result.tables[0].indexes.length).toBe(1);
    expect(result.tables[0].indexes[0].action).toBe("added");
  });

  test("added table includes foreign keys as added", () => {
    const target: DetailedObject[] = [
      makeTable({
        name: "orders",
        columns: [{ name: "user_id", type: "integer", nullable: false, isPrimary: false }],
        foreignKeys: [{ columnName: "user_id", referencedTable: "users", referencedColumn: "id" }],
      }),
    ];
    const result = diffSchemas([], target);
    expect(result.tables[0].foreignKeys.length).toBe(1);
    expect(result.tables[0].foreignKeys[0].action).toBe("added");
  });
});

// ============================================================================
// Removed tables
// ============================================================================

describe("diffSchemas: removed tables", () => {
  test("table in source but not target is marked removed", () => {
    const source: DetailedObject[] = [
      makeTable({
        name: "legacy",
        columns: [{ name: "id", type: "integer", nullable: false, isPrimary: true }],
      }),
    ];
    const result = diffSchemas(source, []);
    expect(result.hasChanges).toBe(true);
    expect(result.summary.removed).toBe(1);
    expect(result.tables[0].action).toBe("removed");
    expect(result.tables[0].tableName).toBe("legacy");
    expect(result.tables[0].columns[0].action).toBe("removed");
  });
});

// ============================================================================
// Modified tables — columns
// ============================================================================

describe("diffSchemas: modified columns", () => {
  test("column added to existing table", () => {
    const source: DetailedObject[] = [
      makeTable({
        name: "users",
        columns: [{ name: "id", type: "integer", nullable: false, isPrimary: true }],
      }),
    ];
    const target: DetailedObject[] = [
      makeTable({
        name: "users",
        columns: [
          { name: "id", type: "integer", nullable: false, isPrimary: true },
          { name: "email", type: "varchar(255)", nullable: false, isPrimary: false },
        ],
      }),
    ];
    const result = diffSchemas(source, target);
    expect(result.summary.modified).toBe(1);
    const table = result.tables.find((t) => t.tableName === "users")!;
    expect(table.action).toBe("modified");
    const addedCol = table.columns.find((c) => c.columnName === "email");
    expect(addedCol?.action).toBe("added");
  });

  test("column removed from existing table", () => {
    const source: DetailedObject[] = [
      makeTable({
        name: "users",
        columns: [
          { name: "id", type: "integer", nullable: false, isPrimary: true },
          { name: "legacy_col", type: "text", nullable: true, isPrimary: false },
        ],
      }),
    ];
    const target: DetailedObject[] = [
      makeTable({
        name: "users",
        columns: [{ name: "id", type: "integer", nullable: false, isPrimary: true }],
      }),
    ];
    const result = diffSchemas(source, target);
    const table = result.tables.find((t) => t.tableName === "users")!;
    const removedCol = table.columns.find((c) => c.columnName === "legacy_col");
    expect(removedCol?.action).toBe("removed");
  });

  test("column type changed", () => {
    const source: DetailedObject[] = [
      makeTable({
        name: "users",
        columns: [{ name: "name", type: "varchar(100)", nullable: false, isPrimary: false }],
      }),
    ];
    const target: DetailedObject[] = [
      makeTable({
        name: "users",
        columns: [{ name: "name", type: "text", nullable: false, isPrimary: false }],
      }),
    ];
    const result = diffSchemas(source, target);
    const table = result.tables.find((t) => t.tableName === "users")!;
    const col = table.columns.find((c) => c.columnName === "name")!;
    expect(col.action).toBe("modified");
    expect(col.changes.some((c) => c.includes("Type changed"))).toBe(true);
  });

  test("column nullable changed", () => {
    const source: DetailedObject[] = [
      makeTable({
        name: "users",
        columns: [{ name: "email", type: "varchar(255)", nullable: true, isPrimary: false }],
      }),
    ];
    const target: DetailedObject[] = [
      makeTable({
        name: "users",
        columns: [{ name: "email", type: "varchar(255)", nullable: false, isPrimary: false }],
      }),
    ];
    const result = diffSchemas(source, target);
    const col = result.tables[0].columns.find((c) => c.columnName === "email")!;
    expect(col.action).toBe("modified");
    expect(col.changes.some((c) => c.includes("Nullable changed"))).toBe(true);
  });

  test("column primary key changed", () => {
    const source: DetailedObject[] = [
      makeTable({
        name: "users",
        columns: [{ name: "uuid", type: "uuid", nullable: false, isPrimary: false }],
      }),
    ];
    const target: DetailedObject[] = [
      makeTable({
        name: "users",
        columns: [{ name: "uuid", type: "uuid", nullable: false, isPrimary: true }],
      }),
    ];
    const result = diffSchemas(source, target);
    const col = result.tables[0].columns.find((c) => c.columnName === "uuid")!;
    expect(col.action).toBe("modified");
    expect(col.changes.some((c) => c.includes("Primary key changed: false → true"))).toBe(true);
  });

  test("column default changed", () => {
    const source: DetailedObject[] = [
      makeTable({
        name: "users",
        columns: [{ name: "status", type: "varchar(50)", nullable: false, isPrimary: false, defaultValue: "'active'" }],
      }),
    ];
    const target: DetailedObject[] = [
      makeTable({
        name: "users",
        columns: [
          { name: "status", type: "varchar(50)", nullable: false, isPrimary: false, defaultValue: "'pending'" },
        ],
      }),
    ];
    const result = diffSchemas(source, target);
    const col = result.tables[0].columns.find((c) => c.columnName === "status")!;
    expect(col.action).toBe("modified");
    expect(col.changes.some((c) => c.includes("Default changed"))).toBe(true);
  });
});

// ============================================================================
// Modified tables — indexes
// ============================================================================

describe("diffSchemas: indexes", () => {
  test("index added", () => {
    const source: DetailedObject[] = [
      makeTable({
        name: "users",
        columns: [{ name: "email", type: "varchar(255)", nullable: false, isPrimary: false }],
        indexes: [],
      }),
    ];
    const target: DetailedObject[] = [
      makeTable({
        name: "users",
        columns: [{ name: "email", type: "varchar(255)", nullable: false, isPrimary: false }],
        indexes: [{ name: "idx_email", columns: ["email"], unique: true }],
      }),
    ];
    const result = diffSchemas(source, target);
    const table = result.tables.find((t) => t.tableName === "users")!;
    expect(table.indexes.length).toBe(1);
    expect(table.indexes[0].action).toBe("added");
    expect(table.indexes[0].indexName).toBe("idx_email");
  });

  test("index removed", () => {
    const source: DetailedObject[] = [
      makeTable({
        name: "users",
        columns: [{ name: "email", type: "varchar(255)", nullable: false, isPrimary: false }],
        indexes: [{ name: "idx_email", columns: ["email"], unique: true }],
      }),
    ];
    const target: DetailedObject[] = [
      makeTable({
        name: "users",
        columns: [{ name: "email", type: "varchar(255)", nullable: false, isPrimary: false }],
        indexes: [],
      }),
    ];
    const result = diffSchemas(source, target);
    const table = result.tables.find((t) => t.tableName === "users")!;
    expect(table.indexes[0].action).toBe("removed");
  });

  test("index columns changed is detected as modified", () => {
    const source: DetailedObject[] = [
      makeTable({
        name: "users",
        columns: [{ name: "email", type: "varchar", nullable: false, isPrimary: false }],
        indexes: [{ name: "idx_users", columns: ["email"], unique: false }],
      }),
    ];
    const target: DetailedObject[] = [
      makeTable({
        name: "users",
        columns: [{ name: "email", type: "varchar", nullable: false, isPrimary: false }],
        indexes: [{ name: "idx_users", columns: ["email", "created_at"], unique: false }],
      }),
    ];
    const result = diffSchemas(source, target);
    const idx = result.tables[0].indexes.find((i) => i.indexName === "idx_users")!;
    expect(idx.action).toBe("modified");
    expect(idx.changes.some((c) => c.includes("Columns changed: (email) → (email, created_at)"))).toBe(true);
  });

  test("index uniqueness changed is detected as modified", () => {
    const source: DetailedObject[] = [
      makeTable({
        name: "users",
        columns: [{ name: "email", type: "varchar", nullable: false, isPrimary: false }],
        indexes: [{ name: "idx_email", columns: ["email"], unique: false }],
      }),
    ];
    const target: DetailedObject[] = [
      makeTable({
        name: "users",
        columns: [{ name: "email", type: "varchar", nullable: false, isPrimary: false }],
        indexes: [{ name: "idx_email", columns: ["email"], unique: true }],
      }),
    ];
    const result = diffSchemas(source, target);
    const idx = result.tables[0].indexes.find((i) => i.indexName === "idx_email")!;
    expect(idx.action).toBe("modified");
    expect(idx.changes.some((c) => c.includes("Unique changed"))).toBe(true);
  });
});

// ============================================================================
// Modified tables — foreign keys
// ============================================================================

describe("diffSchemas: foreign keys", () => {
  test("foreign key added", () => {
    const source: DetailedObject[] = [
      makeTable({
        name: "orders",
        columns: [{ name: "user_id", type: "integer", nullable: false, isPrimary: false }],
        foreignKeys: [],
      }),
    ];
    const target: DetailedObject[] = [
      makeTable({
        name: "orders",
        columns: [{ name: "user_id", type: "integer", nullable: false, isPrimary: false }],
        foreignKeys: [{ columnName: "user_id", referencedTable: "users", referencedColumn: "id" }],
      }),
    ];
    const result = diffSchemas(source, target);
    expect(result.tables[0].foreignKeys[0].action).toBe("added");
  });

  test("foreign key removed", () => {
    const source: DetailedObject[] = [
      makeTable({
        name: "orders",
        columns: [{ name: "user_id", type: "integer", nullable: false, isPrimary: false }],
        foreignKeys: [{ columnName: "user_id", referencedTable: "users", referencedColumn: "id" }],
      }),
    ];
    const target: DetailedObject[] = [
      makeTable({
        name: "orders",
        columns: [{ name: "user_id", type: "integer", nullable: false, isPrimary: false }],
        foreignKeys: [],
      }),
    ];
    const result = diffSchemas(source, target);
    expect(result.tables[0].foreignKeys[0].action).toBe("removed");
  });
});

// ============================================================================
// Summary counts
// ============================================================================

describe("diffSchemas: summary", () => {
  test("summary counts are correct with mixed changes", () => {
    const source: DetailedObject[] = [
      makeTable({ name: "to_remove", columns: [{ name: "id", type: "int", nullable: false, isPrimary: true }] }),
      makeTable({ name: "to_modify", columns: [{ name: "id", type: "int", nullable: false, isPrimary: true }] }),
    ];
    const target: DetailedObject[] = [
      makeTable({
        name: "to_modify",
        columns: [
          { name: "id", type: "int", nullable: false, isPrimary: true },
          { name: "new_col", type: "text", nullable: true, isPrimary: false },
        ],
      }),
      makeTable({ name: "to_add", columns: [{ name: "id", type: "int", nullable: false, isPrimary: true }] }),
    ];
    const result = diffSchemas(source, target);
    expect(result.summary.added).toBe(1);
    expect(result.summary.removed).toBe(1);
    expect(result.summary.modified).toBe(1);
    expect(result.hasChanges).toBe(true);
    expect(result.tables.length).toBe(3);
  });
});

// ============================================================================
// The object model (#789, Task 25c)
// ============================================================================

describe("diffSchemas: the object model", () => {
  test("it takes the objects a consumer holds, kind, segments, readonly arrays and all", () => {
    // The shape the two hooks now produce. Before this migration the engine took
    // `TableSchema`, whose arrays are mutable, so `SchemaDiff.tsx` copied every array of
    // every object on every render to call it. This is the assertion that the copy is gone.
    const source: readonly DetailedObject[] = [
      {
        name: "public.users",
        kind: "table",
        path: ["public", "users"],
        columns: [{ name: "id", type: "integer", nullable: false, isPrimary: true }],
        indexes: [],
        foreignKeys: [],
      },
    ];
    const target: readonly DetailedObject[] = [
      {
        name: "public.users",
        kind: "view",
        path: ["public", "users"],
        columns: [
          { name: "id", type: "integer", nullable: false, isPrimary: true },
          { name: "email", type: "varchar", nullable: false, isPrimary: false },
        ],
        indexes: [],
        foreignKeys: [],
      },
    ];

    const diff = diffSchemas(source, target);

    expect(diff.summary).toEqual({ added: 0, removed: 0, modified: 1 });
    expect(diff.tables[0].columns.map((column) => [column.action, column.columnName])).toEqual([["added", "email"]]);
  });

  test("the comparison is by NAME, so a snapshot taken before kinds existed still diffs", () => {
    // Deliberately NOT keyed on kind or path. A stored snapshot carries neither, so keying
    // on them would report every object in a pre-#789 snapshot as removed and re-added,
    // which is the one thing a schema diff must never invent. The consequence, stated so it
    // is not read as an oversight: this diff cannot say a table became a view.
    const flat: readonly DetailedObject[] = [{ name: "users", columns: [], indexes: [] }];
    const kinded: readonly DetailedObject[] = [
      { name: "users", kind: "view", path: ["public", "users"], columns: [], indexes: [] },
    ];

    expect(diffSchemas(flat, kinded).hasChanges).toBe(false);
  });
});
