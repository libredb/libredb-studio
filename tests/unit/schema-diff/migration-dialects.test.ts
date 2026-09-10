import { describe, expect, test } from "bun:test";
import { generateMigrationSQL } from "@/lib/schema-diff/migration-generator";
import type { SchemaDiff, TableDiff } from "@/lib/schema-diff/types";
import type { DatabaseType } from "@/lib/types";

function diff(table: Partial<TableDiff>): SchemaDiff {
  return {
    hasChanges: true,
    summary: { added: 1, removed: 1, modified: 1 },
    tables: [{ tableName: "items", action: "modified", columns: [], indexes: [], foreignKeys: [], ...table }],
  };
}

// Every canonical id must declare its ADD/DROP grammar; a future provider cannot
// silently inherit PostgreSQL's statements. Null means there is no table DDL.
const COLUMN_GRAMMAR: Record<DatabaseType, [string, string] | null> = {
  postgres: ['ADD COLUMN "extra" integer;', 'DROP COLUMN "old";'],
  mysql: ["ADD COLUMN `extra` integer;", "DROP COLUMN `old`;"],
  mssql: ["ADD [extra] integer;", "DROP COLUMN [old];"],
  oracle: ['ADD ("extra" integer);', 'DROP COLUMN "old";'],
  sqlite: ['ADD COLUMN "extra" integer;', 'Cannot drop column "old" directly.'],
  libsql: ['ADD COLUMN "extra" integer;', 'DROP COLUMN "old";'],
  duckdb: ['ADD COLUMN "extra" integer;', 'DROP COLUMN "old";'],
  cassandra: ['ADD "extra" integer;', 'DROP "old";'],
  clickhouse: ['ADD COLUMN "extra" integer;', 'DROP COLUMN "old";'],
  trino: ['ADD COLUMN "extra" integer;', 'DROP COLUMN "old";'],
  // Db2 LUW uses standard `ADD COLUMN`/`DROP COLUMN` with double-quoted identifiers,
  // the same spelling as PostgreSQL and DuckDB.
  db2: ['ADD COLUMN "extra" integer;', 'DROP COLUMN "old";'],
  couchbase: null,
  druid: null,
  elasticsearch: null,
  opensearch: null,
  mongodb: null,
  redis: null,
  libredb: null,
};

describe("migration dialect regressions (#284)", () => {
  for (const [id, grammar] of Object.entries(COLUMN_GRAMMAR)) {
    const dialect = id as DatabaseType;
    test(`${dialect}: added and removed columns follow the engine grammar`, () => {
      const sql = generateMigrationSQL(
        diff({
          columns: [
            { action: "added", columnName: "extra", targetType: "integer", changes: [] },
            { action: "removed", columnName: "old", changes: [] },
          ],
        }),
        dialect,
      );
      if (grammar) {
        for (const fragment of grammar) expect(sql).toContain(fragment);
      } else {
        expect(sql).toContain("Cannot generate table DDL");
        expect(sql.split("\n").filter((line) => line.trim() && !line.startsWith("--"))).toEqual([]);
      }
    });
    if (grammar) continue;
    for (const action of ["added", "removed", "modified"] as const) {
      test(`${dialect}: ${action} tables and their indexes/keys never leak SQL DDL`, () => {
        const sql = generateMigrationSQL(
          diff({
            action,
            columns: [{ action: "added", columnName: "id", targetType: "integer", targetIsPrimary: true, changes: [] }],
            indexes: [
              { action: "added", indexName: "i", targetColumns: ["id"], changes: [] },
              { action: "removed", indexName: "old_i", changes: [] },
            ],
            foreignKeys: [
              {
                action: "added",
                columnName: "id",
                targetReferencedTable: "parent",
                targetReferencedColumn: "id",
                changes: [],
              },
              { action: "removed", columnName: "old_id", changes: [] },
            ],
          }),
          dialect,
        );
        expect(sql).toContain("Cannot generate table DDL");
        expect(sql.split("\n").filter((line) => line.trim() && !line.startsWith("--"))).toEqual([]);
      });
    }
  }

  test("SQL Server starts a transaction using T-SQL's transaction keyword", () => {
    const sql = generateMigrationSQL(diff({ action: "removed" }), "mssql");
    expect(sql).toMatch(/^BEGIN TRANSACTION;$/m);
    expect(sql).toMatch(/^COMMIT;$/m);
    expect(sql).not.toMatch(/^BEGIN;$/m);
  });

  test("Oracle has no transaction wrapper and uses portable DROP forms", () => {
    const sql = generateMigrationSQL(diff({ action: "removed" }), "oracle");
    expect(sql).toContain('DROP TABLE "items";');
    expect(sql).not.toMatch(/^(BEGIN|COMMIT)/m);
    expect(sql).not.toContain("IF EXISTS");
  });

  for (const action of ["added", "modified"] as const) {
    test(`Oracle ${action} table puts DEFAULT before NOT NULL`, () => {
      const sql = generateMigrationSQL(
        diff({
          action,
          columns: [
            {
              action: "added",
              columnName: 'value"x',
              targetType: "NUMBER",
              targetDefault: "42",
              targetNullable: false,
              changes: [],
            },
          ],
        }),
        "oracle",
      );
      expect(sql).toContain('"value""x" NUMBER DEFAULT 42 NOT NULL');
      expect(sql).not.toContain("NOT NULL DEFAULT");
    });
  }

  for (const dialect of ["mssql", "oracle"] as const) {
    test(`${dialect}: drop indexes and foreign keys before their columns`, () => {
      const sql = generateMigrationSQL(
        diff({
          columns: [{ action: "removed", columnName: "old", changes: [] }],
          indexes: [{ action: "removed", indexName: "idx_old", changes: [] }],
          foreignKeys: [{ action: "removed", columnName: "old", changes: [] }],
        }),
        dialect,
      );
      expect(sql.indexOf("DROP INDEX")).toBeLessThan(sql.indexOf("DROP COLUMN"));
      expect(sql.indexOf("DROP CONSTRAINT")).toBeLessThan(sql.indexOf("DROP COLUMN"));
      if (dialect === "mssql") {
        expect(sql).toContain("DROP INDEX IF EXISTS [idx_old] ON [items];");
        expect(sql).toContain("ALTER TABLE [items] DROP CONSTRAINT IF EXISTS [fk_items_old];");
      } else {
        expect(sql).toContain('DROP INDEX "idx_old";');
        expect(sql).toContain('ALTER TABLE "items" DROP CONSTRAINT "fk_items_old";');
        expect(sql).not.toContain("IF EXISTS");
      }
    });
  }

  for (const dialect of ["mssql", "oracle", "sqlite", "cassandra"] as const) {
    test(`${dialect}: object names cannot escape generated comments with a newline`, () => {
      const attack = "x\r\nDELETE FROM valuable;\n--";
      const sql = generateMigrationSQL(
        diff({
          tableName: attack,
          columns: [{ action: "modified", columnName: attack, targetType: "integer", changes: [] }],
        }),
        dialect,
      );
      const outsideIdentifiers = sql.replace(/"(?:[^"]|"")*"|\[(?:[^\]]|\]\])*\]/g, "identifier");
      expect(outsideIdentifiers).not.toMatch(/^DELETE FROM valuable;$/m);
      // Identifier newlines inside a quoted SQL span remain legal; only comment text is flattened.
      expect(sql).toContain("-- Alter table: x  DELETE FROM valuable; --");
    });
  }
});

describe("index and foreign-key fallback refusals", () => {
  for (const dialect of ["clickhouse", "trino"] as const) {
    for (const action of ["added", "modified"] as const) {
      test(`${dialect}: ${action} table keeps columns but refuses unsupported index/FK clauses`, () => {
        const sql = generateMigrationSQL(
          diff({
            action,
            columns: [{ action: "added", columnName: "id", targetType: "integer", changes: [] }],
            indexes: [
              { action: "added", indexName: "idx", targetColumns: ["id"], changes: [] },
              { action: "removed", indexName: "old_idx", changes: [] },
            ],
            foreignKeys: [
              {
                action: "added",
                columnName: "id",
                targetReferencedTable: "parent",
                targetReferencedColumn: "id",
                changes: [],
              },
              { action: "removed", columnName: "old_id", changes: [] },
            ],
          }),
          dialect,
        );
        expect(sql).toContain('"id" integer');
        expect(sql).toContain("Cannot generate index DDL");
        expect(sql).toContain("Cannot add a foreign key");
        if (action === "modified") expect(sql).toContain("Cannot drop a foreign key");
        expect(sql).not.toMatch(/^(CREATE (UNIQUE )?INDEX|DROP INDEX|ALTER TABLE .* (ADD|DROP) CONSTRAINT)/m);
      });
    }
  }

  test("Trino primary keys are declined rather than written into CREATE TABLE", () => {
    const sql = generateMigrationSQL(
      diff({
        action: "added",
        columns: [{ action: "added", columnName: "id", targetType: "integer", targetIsPrimary: true, changes: [] }],
      }),
      "trino",
    );
    expect(sql).toContain("Cannot declare a primary key");
    expect(sql).not.toContain("PRIMARY KEY (");
    expect(sql).toContain('CREATE TABLE "items"');
  });

  test("Oracle's missing type fallback is valid on both CREATE and ADD paths", () => {
    for (const action of ["added", "modified"] as const) {
      const sql = generateMigrationSQL(
        diff({ action, columns: [{ action: "added", columnName: "x", changes: [] }] }),
        "oracle",
      );
      expect(sql).toContain('"x" VARCHAR2(255)');
    }
  });
});
