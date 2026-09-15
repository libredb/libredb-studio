import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { diffSchemas } from "@/lib/schema-diff/diff-engine";
import { generateMigrationSQL } from "@/lib/schema-diff/migration-generator";
import type { DetailedObject } from "@/lib/db/detailed-object";

function table(columns: string[], indexColumns: string[], unique = false): DetailedObject {
  return {
    name: "items",
    kind: "table",
    path: ["items"],
    columns: columns.map((name) => ({ name, type: "INTEGER", nullable: true, isPrimary: false })),
    indexes: [{ name: "idx_items", columns: indexColumns, unique }],
    foreignKeys: [],
  };
}

describe("schema comparison through index migration", () => {
  for (const dialect of ["mssql", "oracle"] as const) {
    test(`${dialect}: a changed index is dropped before its old column and recreated afterwards`, () => {
      const diff = diffSchemas([table(["old"], ["old"])], [table(["replacement"], ["replacement"])]);
      expect(diff.tables[0].indexes[0].action).toBe("modified");
      const sql = generateMigrationSQL(diff, dialect);
      expect(sql).toContain("DROP INDEX");
      expect(sql).toContain("CREATE INDEX");
      expect(sql.indexOf("DROP INDEX")).toBeLessThan(sql.indexOf("DROP COLUMN"));
      expect(sql.indexOf("CREATE INDEX")).toBeGreaterThan(sql.indexOf("DROP COLUMN"));
      if (dialect === "mssql") {
        expect(sql).toContain("DROP INDEX IF EXISTS [idx_items] ON [items];");
        expect(sql).toContain("CREATE INDEX [idx_items] ON [items] ([replacement]);");
      } else {
        expect(sql).toContain('DROP INDEX "idx_items";');
        expect(sql).toContain('CREATE INDEX "idx_items" ON "items" ("replacement");');
      }
    });
  }

  test("a composite index's order is a schema change and is applied to SQLite", () => {
    const source = table(["a", "b"], ["a", "b"]);
    const target = table(["a", "b"], ["b", "a"]);
    const diff = diffSchemas([source], [target]);
    expect(diff.hasChanges).toBe(true);
    expect(source.indexes[0].columns).toEqual(["a", "b"]);
    expect(target.indexes[0].columns).toEqual(["b", "a"]);
    const db = new Database(":memory:");
    try {
      db.exec("CREATE TABLE items (a INTEGER, b INTEGER); CREATE INDEX idx_items ON items (a, b)");
      db.exec(generateMigrationSQL(diff, "sqlite"));
      expect(
        db
          .query<{ name: string }, []>("PRAGMA index_info(idx_items)")
          .all()
          .map((row) => row.name),
      ).toEqual(["b", "a"]);
    } finally {
      db.close();
    }
  });

  test("a uniqueness change actually enforces the target constraint", () => {
    const diff = diffSchemas([table(["a"], ["a"])], [table(["a"], ["a"], true)]);
    const db = new Database(":memory:");
    try {
      db.exec("CREATE TABLE items (a INTEGER); CREATE INDEX idx_items ON items (a); INSERT INTO items VALUES (1)");
      db.exec(generateMigrationSQL(diff, "sqlite"));
      expect(() => db.exec("INSERT INTO items VALUES (1)")).toThrow();
      expect(db.query<{ a: number }, []>("SELECT a FROM items").all()).toEqual([{ a: 1 }]);
    } finally {
      db.close();
    }
  });

  test("commas in column names cannot hide a changed index", () => {
    const diff = diffSchemas(
      [table(["a,b", "c", "a", "b,c"], ["a,b", "c"])],
      [table(["a,b", "c", "a", "b,c"], ["a", "b,c"])],
    );
    expect(diff.hasChanges).toBe(true);
    expect(generateMigrationSQL(diff, "oracle")).toContain('CREATE INDEX "idx_items" ON "items" ("a", "b,c");');
  });

  for (const dialect of ["clickhouse", "trino"] as const) {
    test(`${dialect}: a modified index reports its unsupported grammar`, () => {
      const sql = generateMigrationSQL(diffSchemas([table(["a", "b"], ["a"])], [table(["a", "b"], ["b"])]), dialect);
      expect(sql).toContain("Cannot generate index DDL");
      expect(sql).not.toMatch(/^(DROP INDEX|CREATE INDEX)/m);
    });
  }
});
