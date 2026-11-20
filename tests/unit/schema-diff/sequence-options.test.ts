import { describe, expect, test } from "bun:test";
import type { StoredObject } from "@/lib/db/detailed-object";
import { diffSchemas } from "@/lib/schema-diff/diff-engine";
import { generateMigrationSQL } from "@/lib/schema-diff/migration-generator";
import type { ColumnSchema, ColumnSequence } from "@/lib/types";

// ============================================================================
// A sequence keeps its options and its owner in the PostgreSQL migration
// ============================================================================

/**
 * Measured on PostgreSQL 19.0: the migration wrote `CREATE SEQUENCE IF NOT EXISTS app.t_id_seq;` for a sequence
 * declared `START 1000 INCREMENT 5`, so the rebuilt table numbered its rows from 1 by 1, and the sequence no longer
 * belonged to its column, so dropping the table left it behind.
 */

const column = (name: string, extra: Partial<ColumnSchema> = {}): ColumnSchema => ({
  name,
  type: "int",
  nullable: true,
  isPrimary: false,
  ...extra,
});

const table = (path: string[], columns: ColumnSchema[]): StoredObject => ({
  name: path[path.length - 1],
  path,
  kind: "table",
  columns,
  indexes: [],
  foreignKeys: [],
});

const SEQUENCE: ColumnSequence = {
  dataType: "integer",
  start: "1000",
  increment: "5",
  min: "1000",
  max: "2147483647",
  cache: "1",
  cycle: false,
  ownedByColumn: true,
};

const serial = (sequence: ColumnSequence | undefined, name = "app.t_id_seq") =>
  column("id", {
    autoIncrement: true,
    nullable: false,
    defaultValue: `nextval('${name}'::regclass)`,
    ...(sequence === undefined ? {} : { sequence }),
  });

const anchor = table(["app", "anchor"], [column("id")]);

/** Where `needle` first appears in `sql`, failing when it does not. */
function at(sql: string, needle: string): number {
  const index = sql.indexOf(needle);
  if (index < 0) throw new Error(`not in the migration: ${needle}\n${sql}`);
  return index;
}

const CREATED =
  "CREATE SEQUENCE IF NOT EXISTS app.t_id_seq AS integer INCREMENT BY 5 MINVALUE 1000 MAXVALUE 2147483647 START WITH 1000 CACHE 1 NO CYCLE;";
const OWNED = 'ALTER SEQUENCE app.t_id_seq OWNED BY "app"."t"."id";';

describe("diffSchemas: a column's sequence", () => {
  test("is carried onto an added column, and absent where the provider read none", () => {
    const diff = diffSchemas([anchor], [anchor, table(["app", "t"], [serial(SEQUENCE), column("note")])]);
    const columns = diff.tables.find((t) => t.tableName === "t")?.columns ?? [];
    expect(columns.find((c) => c.columnName === "id")?.targetSequence).toEqual(SEQUENCE);
    expect(columns.find((c) => c.columnName === "note")).not.toHaveProperty("targetSequence");
  });
});

describe("generateMigrationSQL: PostgreSQL sequence options and owner", () => {
  test("a new table's sequence is created with its options, and given back to its column after the table", () => {
    const sql = generateMigrationSQL(
      diffSchemas([anchor], [anchor, table(["app", "t"], [serial(SEQUENCE)])]),
      "postgres",
    );
    expect(at(sql, CREATED)).toBeLessThan(at(sql, 'CREATE TABLE "app"."t"'));
    expect(at(sql, OWNED)).toBeGreaterThan(at(sql, 'CREATE TABLE "app"."t"'));
    expect(at(sql, OWNED)).toBeLessThan(at(sql, "COMMIT;"));
    expect(sql).not.toContain("CREATE SEQUENCE IF NOT EXISTS app.t_id_seq;");
  });

  test("a column added to an existing table gets the same, after its ADD COLUMN", () => {
    const sql = generateMigrationSQL(
      diffSchemas(
        [anchor, table(["app", "t"], [column("note")])],
        [anchor, table(["app", "t"], [column("note"), serial(SEQUENCE)])],
      ),
      "postgres",
    );
    expect(at(sql, CREATED)).toBeLessThan(at(sql, "ADD COLUMN"));
    expect(at(sql, OWNED)).toBeGreaterThan(at(sql, "ADD COLUMN"));
  });

  test("a cycling sequence says CYCLE, and one no column owns is not given an owner", () => {
    const sql = generateMigrationSQL(
      diffSchemas(
        [anchor],
        [anchor, table(["app", "t"], [serial({ ...SEQUENCE, cycle: true, ownedByColumn: false })])],
      ),
      "postgres",
    );
    expect(sql).toContain("START WITH 1000 CACHE 1 CYCLE;");
    expect(sql).not.toContain("NO CYCLE");
    expect(sql).not.toContain("OWNED BY");
  });

  test("a sequence the provider did not read is created as before, with no owner", () => {
    const sql = generateMigrationSQL(
      diffSchemas([anchor], [anchor, table(["app", "t"], [serial(undefined)])]),
      "postgres",
    );
    expect(sql).toContain("CREATE SEQUENCE IF NOT EXISTS app.t_id_seq;");
    expect(sql).not.toContain("OWNED BY");
  });

  test("options that are not numbers or a sequence type are left out, so a stored snapshot cannot add a statement", () => {
    for (const bad of [
      { ...SEQUENCE, start: "1; DROP TABLE app.anchor" },
      { ...SEQUENCE, dataType: "integer; DROP TABLE app.anchor" },
      { ...SEQUENCE, max: "" },
    ]) {
      const sql = generateMigrationSQL(diffSchemas([anchor], [anchor, table(["app", "t"], [serial(bad)])]), "postgres");
      expect(sql).toContain("CREATE SEQUENCE IF NOT EXISTS app.t_id_seq;");
      expect(sql).not.toContain("DROP TABLE");
      // The owner is still a name the default already proved to be one.
      expect(sql).toContain(OWNED);
    }
  });

  test("a default that names no plain sequence gives nothing an owner", () => {
    const sql = generateMigrationSQL(
      diffSchemas(
        [anchor],
        [
          anchor,
          table(
            ["app", "t"],
            [column("id", { defaultValue: "(nextval('app.t_id_seq'::regclass) + 1)", sequence: SEQUENCE })],
          ),
        ],
      ),
      "postgres",
    );
    expect(sql).not.toContain("SEQUENCE");
  });

  test("other engines write neither", () => {
    const sql = generateMigrationSQL(diffSchemas([anchor], [anchor, table(["app", "t"], [serial(SEQUENCE)])]), "mysql");
    expect(sql).not.toContain("SEQUENCE");
  });
});
