import { describe, test, expect } from "bun:test";
import { diffSchemas } from "@/lib/schema-diff/diff-engine";
import type { StoredObject } from "@/lib/db/detailed-object";
import type { ColumnSchema } from "@/lib/types";

// ============================================================================
// Helpers
// ============================================================================

function makeTable(overrides: Partial<StoredObject> & { name: string }): StoredObject {
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
    const schema: StoredObject[] = [
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
    const target: StoredObject[] = [
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
    const target: StoredObject[] = [
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
    const target: StoredObject[] = [
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
    const source: StoredObject[] = [
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
    const source: StoredObject[] = [
      makeTable({
        name: "users",
        columns: [{ name: "id", type: "integer", nullable: false, isPrimary: true }],
      }),
    ];
    const target: StoredObject[] = [
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
    const source: StoredObject[] = [
      makeTable({
        name: "users",
        columns: [
          { name: "id", type: "integer", nullable: false, isPrimary: true },
          { name: "legacy_col", type: "text", nullable: true, isPrimary: false },
        ],
      }),
    ];
    const target: StoredObject[] = [
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
    const source: StoredObject[] = [
      makeTable({
        name: "users",
        columns: [{ name: "name", type: "varchar(100)", nullable: false, isPrimary: false }],
      }),
    ];
    const target: StoredObject[] = [
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
    const source: StoredObject[] = [
      makeTable({
        name: "users",
        columns: [{ name: "email", type: "varchar(255)", nullable: true, isPrimary: false }],
      }),
    ];
    const target: StoredObject[] = [
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
    const source: StoredObject[] = [
      makeTable({
        name: "users",
        columns: [{ name: "uuid", type: "uuid", nullable: false, isPrimary: false }],
      }),
    ];
    const target: StoredObject[] = [
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
    const source: StoredObject[] = [
      makeTable({
        name: "users",
        columns: [{ name: "status", type: "varchar(50)", nullable: false, isPrimary: false, defaultValue: "'active'" }],
      }),
    ];
    const target: StoredObject[] = [
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

  // The comparison must read the same quantity the migration generator emits, the SQL text,
  // and must tell an EMPTY default apart from NO default. A MariaDB column declared
  // `DEFAULT ''` reports the value "" and the expression "''"; a column with no default at
  // all reports neither field. A truthiness fallback collapses those two onto the same
  // string and reports no change for a difference that is really there.
  function defaultChanges(source: Partial<ColumnSchema>, target: Partial<ColumnSchema>): string[] {
    const base = { name: "note", type: "varchar(20)", nullable: true, isPrimary: false };
    const result = diffSchemas(
      [makeTable({ name: "users", columns: [{ ...base, ...source }] })],
      [makeTable({ name: "users", columns: [{ ...base, ...target }] })],
    );
    const col = result.tables[0]?.columns.find((c) => c.columnName === "note");
    return (col?.changes ?? []).filter((c) => c.startsWith("Default changed"));
  }

  test("adding an empty-string default is a change", () => {
    expect(defaultChanges({}, { defaultValue: "", defaultExpression: "''" })).toEqual(["Default changed: none → ''"]);
  });

  test("dropping an empty-string default is a change", () => {
    expect(defaultChanges({ defaultValue: "", defaultExpression: "''" }, {})).toEqual(["Default changed: '' → none"]);
  });

  test("a snapshot taken before the decoding compares equal to the unchanged table", () => {
    // An old snapshot stored MariaDB's catalog text in `defaultValue`; a reading taken today
    // decodes it there and keeps the text in `defaultExpression`. Same column, no change.
    expect(defaultChanges({ defaultValue: "'abc'" }, { defaultValue: "abc", defaultExpression: "'abc'" })).toEqual([]);
  });

  test("a MySQL snapshot taken before the DDL read reports one change per quoted default", () => {
    // Measured and accepted, like the MariaDB keyword case (#1031): the old snapshot holds
    // only the catalog's value, today's reading holds the SQL text too, and the text differs
    // for every default the server spells with quotes or as an expression. A new snapshot
    // clears it. A bare number is one text on both sides and reports nothing.
    expect(defaultChanges({ defaultValue: "abc" }, { defaultValue: "abc", defaultExpression: "'abc'" })).toEqual([
      "Default changed: abc → 'abc'",
    ]);
    expect(defaultChanges({ defaultValue: "42" }, { defaultValue: "42", defaultExpression: "42" })).toEqual([]);
  });

  test("a real default change is still reported", () => {
    expect(
      defaultChanges(
        { defaultValue: "abc", defaultExpression: "'abc'" },
        { defaultValue: "xyz", defaultExpression: "'xyz'" },
      ),
    ).toEqual(["Default changed: 'abc' → 'xyz'"]);
  });

  test("a provider that sets no expression is unaffected", () => {
    const pg = "nextval('app.orders_id_seq'::regclass)";
    expect(defaultChanges({ defaultValue: pg }, { defaultValue: pg })).toEqual([]);
    expect(defaultChanges({ defaultValue: pg }, { defaultValue: "0" })).toEqual([`Default changed: ${pg} → 0`]);
  });
});

// ============================================================================
// Modified tables — indexes
// ============================================================================

describe("diffSchemas: indexes", () => {
  test("index added", () => {
    const source: StoredObject[] = [
      makeTable({
        name: "users",
        columns: [{ name: "email", type: "varchar(255)", nullable: false, isPrimary: false }],
        indexes: [],
      }),
    ];
    const target: StoredObject[] = [
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
    const source: StoredObject[] = [
      makeTable({
        name: "users",
        columns: [{ name: "email", type: "varchar(255)", nullable: false, isPrimary: false }],
        indexes: [{ name: "idx_email", columns: ["email"], unique: true }],
      }),
    ];
    const target: StoredObject[] = [
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

  test("skips index comparison when target indexes are refused", () => {
    const source: StoredObject[] = [
      makeTable({
        name: "users",
        columns: [{ name: "email", type: "varchar(255)", nullable: false, isPrimary: false }],
        indexes: [{ name: "idx_email", columns: ["email"], unique: true }],
      }),
    ];
    const target: StoredObject[] = [
      makeTable({
        name: "users",
        columns: [{ name: "email", type: "varchar(255)", nullable: false, isPrimary: false }],
        indexes: { unavailable: "ACCESS_DENIED" },
      }),
    ];
    const result = diffSchemas(source, target);
    expect(result.hasChanges).toBe(false);
    expect(result.tables).toHaveLength(0);
  });

  test("skips index comparison when source indexes are refused", () => {
    const source: StoredObject[] = [
      makeTable({
        name: "users",
        columns: [{ name: "email", type: "varchar(255)", nullable: false, isPrimary: false }],
        indexes: { unavailable: "ACCESS_DENIED" },
      }),
    ];
    const target: StoredObject[] = [
      makeTable({
        name: "users",
        columns: [{ name: "email", type: "varchar(255)", nullable: false, isPrimary: false }],
        indexes: [{ name: "idx_email", columns: ["email"], unique: true }],
      }),
    ];
    const result = diffSchemas(source, target);
    expect(result.hasChanges).toBe(false);
    expect(result.tables).toHaveLength(0);
  });

  test("index columns changed is detected as modified", () => {
    const source: StoredObject[] = [
      makeTable({
        name: "users",
        columns: [{ name: "email", type: "varchar", nullable: false, isPrimary: false }],
        indexes: [{ name: "idx_users", columns: ["email"], unique: false }],
      }),
    ];
    const target: StoredObject[] = [
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
    const source: StoredObject[] = [
      makeTable({
        name: "users",
        columns: [{ name: "email", type: "varchar", nullable: false, isPrimary: false }],
        indexes: [{ name: "idx_email", columns: ["email"], unique: false }],
      }),
    ];
    const target: StoredObject[] = [
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
    const source: StoredObject[] = [
      makeTable({
        name: "orders",
        columns: [{ name: "user_id", type: "integer", nullable: false, isPrimary: false }],
        foreignKeys: [],
      }),
    ];
    const target: StoredObject[] = [
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
    const source: StoredObject[] = [
      makeTable({
        name: "orders",
        columns: [{ name: "user_id", type: "integer", nullable: false, isPrimary: false }],
        foreignKeys: [{ columnName: "user_id", referencedTable: "users", referencedColumn: "id" }],
      }),
    ];
    const target: StoredObject[] = [
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
    const source: StoredObject[] = [
      makeTable({ name: "to_remove", columns: [{ name: "id", type: "int", nullable: false, isPrimary: true }] }),
      makeTable({ name: "to_modify", columns: [{ name: "id", type: "int", nullable: false, isPrimary: true }] }),
    ];
    const target: StoredObject[] = [
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
    const source: readonly StoredObject[] = [
      {
        name: "public.users",
        kind: "table",
        path: ["public", "users"],
        columns: [{ name: "id", type: "integer", nullable: false, isPrimary: true }],
        indexes: [],
        foreignKeys: [],
      },
    ];
    const target: readonly StoredObject[] = [
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

  test("a snapshot taken before kinds and paths existed is still compared by NAME", () => {
    // Deliberately NOT keyed on kind or path. A stored snapshot carries neither, so keying
    // on them would report every object in a pre-#789 snapshot as removed and re-added,
    // which is the one thing a schema diff must never invent. The consequence, stated so it
    // is not read as an oversight: this diff cannot say a table became a view.
    const flat: readonly StoredObject[] = [{ name: "users", columns: [], indexes: [] }];
    const kinded: readonly StoredObject[] = [
      { name: "users", kind: "view", path: ["public", "users"], columns: [], indexes: [] },
    ];

    expect(diffSchemas(flat, kinded).hasChanges).toBe(false);
  });
});

// ============================================================================
// The SQL text of a default (#795)
// ============================================================================

describe("diffSchemas: a column's default carries both readings", () => {
  // `defaultValue` is the value a display shows and `defaultExpression` is the SQL that
  // produces it, so the diff has to carry both on to the generator: dropping the second
  // would leave the generator interpolating a value where SQL belongs.
  const withDefault = {
    name: "note",
    type: "varchar(20)",
    nullable: true,
    isPrimary: false,
    defaultValue: "abc",
    defaultExpression: "'abc'",
  };

  test("an added table's columns carry the SQL text", () => {
    const diff = diffSchemas([], [makeTable({ name: "users", columns: [withDefault] })]);

    expect(diff.tables[0].columns[0]).toMatchObject({ targetDefault: "abc", targetDefaultSql: "'abc'" });
  });

  test("a column added to an existing table carries the SQL text", () => {
    const diff = diffSchemas(
      [makeTable({ name: "users", columns: [] })],
      [makeTable({ name: "users", columns: [withDefault] })],
    );

    expect(diff.tables[0].columns[0]).toMatchObject({ targetDefault: "abc", targetDefaultSql: "'abc'" });
  });

  test("a modified column carries the SQL text", () => {
    const diff = diffSchemas(
      [makeTable({ name: "users", columns: [{ ...withDefault, defaultValue: "xyz", defaultExpression: "'xyz'" }] })],
      [makeTable({ name: "users", columns: [withDefault] })],
    );

    expect(diff.tables[0].columns[0]).toMatchObject({ targetDefault: "abc", targetDefaultSql: "'abc'" });
  });

  test("a provider that reports no expression leaves the field absent", () => {
    const diff = diffSchemas(
      [],
      [makeTable({ name: "users", columns: [{ ...withDefault, defaultExpression: undefined }] })],
    );

    expect(diff.tables[0].columns[0].targetDefaultSql).toBeUndefined();
    expect(diff.tables[0].columns[0].targetDefault).toBe("abc");
  });
});

// ============================================================================
// Identity by path below the roots (SF-047, BACKLOG D150)
// ============================================================================

describe("diffSchemas: objects keyed by their path below the compared roots", () => {
  const col = (name: string): ColumnSchema => ({ name, type: "int", nullable: true, isPrimary: false });
  const at = (path: string[], columns: string[], kind = "table"): StoredObject =>
    makeTable({ name: path[path.length - 1], path, kind, columns: columns.map(col) });

  test("two schemas' same-named tables are two objects, each with its own schema", () => {
    const source = [at(["b2a", "t1"], ["a"]), at(["b2b", "t1"], ["a"])];
    const target = [at(["b2a", "t1"], ["a"]), at(["b2b", "t1"], ["a", "b"])];

    const diff = diffSchemas(source, target);

    expect(diff.summary).toEqual({ added: 0, removed: 0, modified: 1 });
    expect(diff.tables[0]).toMatchObject({ tableName: "t1", label: "b2b.t1", path: ["b2b", "t1"], kind: "table" });
    expect(diff.tables[0].columns.map((c) => c.columnName)).toEqual(["b"]);
  });

  test("two connections rooted in different containers compare object by object", () => {
    const source = [
      at(["STUDIO_DEMO", "PROBE", "D_PARENT"], ["PID", "NAME"]),
      at(["STUDIO_DEMO", "PROBE", "ONLY_1"], ["X"]),
    ];
    const target = [
      at(["STUDIO_DEMO2", "D_DIFF", "D_PARENT"], ["PID", "NAME", "EXTRA"]),
      at(["STUDIO_DEMO2", "D_DIFF", "D_ONLY_IN_2"], ["X"]),
    ];

    const diff = diffSchemas(source, target);
    const byLabel = Object.fromEntries(diff.tables.map((t) => [t.label, t]));

    expect(diff.summary).toEqual({ added: 1, removed: 1, modified: 1 });
    expect(byLabel.D_PARENT.path).toEqual(["STUDIO_DEMO", "PROBE", "D_PARENT"]);
    // An added object is placed under the SOURCE's root, which is where the migration runs.
    expect(byLabel.D_ONLY_IN_2.path).toEqual(["STUDIO_DEMO", "PROBE", "D_ONLY_IN_2"]);
    expect(byLabel.ONLY_1.path).toEqual(["STUDIO_DEMO", "PROBE", "ONLY_1"]);
  });

  test("a side spanning more schemas than the other keeps the schema in every key", () => {
    const source = [at(["s1", "t"], ["a"]), at(["s2", "u"], ["a"])];
    const target = [at(["s1", "t"], ["a"])];

    const diff = diffSchemas(source, target);

    expect(diff.tables.map((t) => [t.action, t.label])).toEqual([["removed", "s2.u"]]);
  });

  test("an empty source places an added object at its path below the target's root, never at the target's own", () => {
    // The migration runs on the source, so the target's database and schema are not where it creates anything.
    const diff = diffSchemas([], [at(["DB2", "D_DIFF", "T1"], ["a"]), at(["DB2", "D_DIFF", "T2"], ["a"])]);
    expect(diff.tables.map((table) => table.path)).toEqual([["T1"], ["T2"]]);
    expect(diffSchemas([], [at(["s1", "t"], ["a"]), at(["s2", "t"], ["a"])]).tables.map((t) => t.path)).toEqual([
      ["s1", "t"],
      ["s2", "t"],
    ]);
    expect(diffSchemas([], []).hasChanges).toBe(false);
  });

  test("a pair whose either side is not a table is judged by that kind", () => {
    const diff = diffSchemas([at(["db", "v1"], ["name"], "view")], [at(["db", "v1"], ["name", "x"], "table")]);
    expect(diff.tables[0].kind).toBe("view");
    const unkinded = diffSchemas(
      [makeTable({ name: "t", path: ["db", "t"], columns: [col("a")] })],
      [makeTable({ name: "t", path: ["db", "t"], columns: [col("b")] })],
    );
    expect(unkinded.tables[0].kind).toBeUndefined();
  });

  test("a reading without paths keys every object by name and places none", () => {
    const diff = diffSchemas([makeTable({ name: "t", columns: [col("a")] })], [at(["db", "t"], ["b"])]);
    expect(diff.tables[0]).toMatchObject({ tableName: "t", key: "t", label: "t" });
    expect(diff.tables[0].path).toBeUndefined();
  });
});
