import { describe, expect, test } from "bun:test";
import type { StoredObject } from "@/lib/db/detailed-object";
import { diffSchemas } from "@/lib/schema-diff/diff-engine";
import { generateMigrationSQL } from "@/lib/schema-diff/migration-generator";
import type { SchemaDiff, TableDiff } from "@/lib/schema-diff/types";
import type { ColumnSchema, ForeignKeySchema } from "@/lib/types";

// ============================================================================
// Tables created in the order their foreign keys need (R7)
// ============================================================================

const column = (name: string, extra: Partial<ColumnSchema> = {}): ColumnSchema => ({
  name,
  type: "int",
  nullable: true,
  isPrimary: false,
  ...extra,
});

const table = (path: string[], columns: ColumnSchema[], foreignKeys: ForeignKeySchema[] = []): StoredObject => ({
  name: path[path.length - 1],
  path,
  kind: "table",
  columns,
  indexes: [],
  foreignKeys,
});

const fk = (columnName: string, referencedTable: string): ForeignKeySchema => ({
  columnName,
  referencedTable,
  referencedColumn: "id",
});

/** Where `needle` first appears in `sql`, failing when it does not. */
function at(sql: string, needle: string): number {
  const index = sql.indexOf(needle);
  if (index < 0) throw new Error(`not in the migration: ${needle}\n${sql}`);
  return index;
}

describe("generateMigrationSQL: new tables follow their foreign keys (R7)", () => {
  /**
   * Measured on SQL Server 2022, MySQL 8.4 and Db2 through Schema Diff > SQL Migration: `rg_s1.rg_orders` was
   * created, and its foreign key to `rg_s2.rg_ext` added, before `rg_s2.rg_ext` existed, because the tables were
   * written in the reading's order. The script stopped at that ALTER ("Could not create constraint or index",
   * "Failed to open the referenced table", SQL0204N).
   */
  const orders = table(
    ["shop", "rg_s1", "rg_orders"],
    [column("id"), column("ext_id")],
    [fk("ext_id", "rg_s2.rg_ext")],
  );
  const ext = table(["shop", "rg_s2", "rg_ext"], [column("id")]);

  test("a referenced table is created before the table whose foreign key names it", () => {
    const sql = generateMigrationSQL(diffSchemas([], [orders, ext]), "mssql");
    // With nothing in the source, the new tables are written below the container they share, `shop`.
    const create = at(sql, "CREATE TABLE [rg_s2].[rg_ext]");
    expect(create).toBeLessThan(at(sql, "CREATE TABLE [rg_s1].[rg_orders]"));
    expect(create).toBeLessThan(at(sql, "REFERENCES [rg_s2].[rg_ext]([id])"));
  });

  test("a chain is created from its end, and an unrelated table keeps its place", () => {
    const a = table(["app", "a"], [column("b_id")], [fk("b_id", "b")]);
    const b = table(["app", "b"], [column("c_id")], [fk("c_id", "c")]);
    const c = table(["app", "c"], [column("id")]);
    const z = table(["app", "z"], [column("id")]);
    const sql = generateMigrationSQL(diffSchemas([], [z, a, b, c]), "postgres");
    const order = ["z", "c", "b", "a"].map((name) => at(sql, `CREATE TABLE "${name}"`));
    expect([...order].sort((x, y) => x - y)).toEqual(order);
  });

  test("a foreign key to itself or to a table that already exists does not move a table", () => {
    const tree = table(["app", "tree"], [column("id"), column("parent_id")], [fk("parent_id", "tree")]);
    const users = table(["app", "users"], [column("id")]);
    const posts = table(["app", "posts"], [column("user_id")], [fk("user_id", "users")]);
    const sql = generateMigrationSQL(diffSchemas([users], [users, posts, tree]), "postgres");
    expect(at(sql, 'CREATE TABLE "app"."posts"')).toBeLessThan(at(sql, 'CREATE TABLE "app"."tree"'));
    // The self-reference stays right after its own table.
    expect(at(sql, 'REFERENCES "app"."tree"("id")')).toBeLessThan(at(sql, "COMMIT;"));
    expect(sql).not.toContain("-- Foreign keys between new tables");
  });

  test("a cycle creates every table first and adds the foreign key that closes it afterwards", () => {
    const a = table(["app", "a"], [column("id"), column("b_id")], [fk("b_id", "b")]);
    const b = table(["app", "b"], [column("id"), column("a_id")], [fk("a_id", "a")]);
    const sql = generateMigrationSQL(diffSchemas([], [a, b]), "mysql");
    const lastCreate = Math.max(at(sql, "CREATE TABLE `a`"), at(sql, "CREATE TABLE `b`"));
    const section = at(sql, "-- Foreign keys between new tables");
    expect(section).toBeGreaterThan(lastCreate);
    // The key into a table already created stays with its table; the one into a table not yet created waits.
    expect(at(sql, "ALTER TABLE `b` ADD CONSTRAINT `fk_b_a_id`")).toBeLessThan(section);
    expect(at(sql, "ALTER TABLE `a` ADD CONSTRAINT `fk_a_b_id`")).toBeGreaterThan(section);
  });

  test("an engine that declares its foreign keys inside CREATE TABLE is still ordered, and a cycle keeps them inside", () => {
    const a = table(["a"], [column("b_id")], [fk("b_id", "b")]);
    const b = table(["b"], [column("id")]);
    const ordered = generateMigrationSQL(diffSchemas([], [a, b]), "sqlite");
    expect(at(ordered, 'CREATE TABLE "b"')).toBeLessThan(at(ordered, 'CREATE TABLE "a"'));

    const cyclic = generateMigrationSQL(
      diffSchemas([], [a, table(["b"], [column("id"), column("a_id")], [fk("a_id", "a")])]),
      "sqlite",
    );
    // SQLite resolves a foreign key when a row is written, not when the table is created, so the key stays declared.
    expect(cyclic).toContain('FOREIGN KEY ("b_id") REFERENCES "b"("id")');
    expect(cyclic).not.toContain("-- Foreign keys between new tables");
  });

  test("a diff without paths matches a reference to a new table by its name", () => {
    const diff: SchemaDiff = {
      hasChanges: true,
      summary: { added: 2, removed: 0, modified: 0 },
      tables: [
        {
          action: "added",
          tableName: "orders",
          columns: [{ action: "added", columnName: "customer_id", targetType: "int", changes: [] }],
          indexes: [],
          foreignKeys: [
            {
              action: "added",
              columnName: "customer_id",
              targetReferencedTable: "customers",
              targetReferencedColumn: "id",
              changes: [],
            },
          ],
        },
        {
          action: "added",
          tableName: "customers",
          columns: [{ action: "added", columnName: "id", targetType: "int", changes: [] }],
          indexes: [],
          foreignKeys: [],
        } satisfies TableDiff,
      ],
    };
    const sql = generateMigrationSQL(diff, "postgres");
    expect(at(sql, 'CREATE TABLE "customers"')).toBeLessThan(at(sql, 'CREATE TABLE "orders"'));
  });
});

// ============================================================================
// A column the engine numbers itself keeps that property (R8)
// ============================================================================

describe("generateMigrationSQL: auto-numbered columns (R8)", () => {
  /**
   * Measured on MySQL 8.4 and SQL Server 2022 through Schema Diff > SQL Migration: `id int AUTO_INCREMENT` and
   * `id int IDENTITY` were both written `id int NOT NULL`, so the re-created table refused every INSERT that left
   * the key out.
   */
  const keyed = (extra: Partial<ColumnSchema>) =>
    table(["app", "t"], [column("id", { nullable: false, isPrimary: true, ...extra }), column("note")]);

  test("MySQL writes AUTO_INCREMENT", () => {
    const sql = generateMigrationSQL(diffSchemas([], [keyed({ autoIncrement: true })]), "mysql");
    expect(sql).toContain("`id` int AUTO_INCREMENT NOT NULL,");
  });

  test("SQL Server writes IDENTITY(1,1)", () => {
    const sql = generateMigrationSQL(diffSchemas([], [keyed({ autoIncrement: true })]), "mssql");
    expect(sql).toContain("[id] int IDENTITY(1,1) NOT NULL,");
  });

  test("Oracle and Db2 write an identity generated by default", () => {
    expect(generateMigrationSQL(diffSchemas([], [keyed({ autoIncrement: true })]), "oracle")).toContain(
      '"id" int GENERATED BY DEFAULT AS IDENTITY NOT NULL,',
    );
    expect(generateMigrationSQL(diffSchemas([], [keyed({ autoIncrement: true })]), "db2")).toContain(
      '"id" int GENERATED BY DEFAULT AS IDENTITY NOT NULL,',
    );
  });

  test("the identity replaces a default the catalog reported for it", () => {
    // Oracle reports an identity column's default as the system sequence behind it.
    const sql = generateMigrationSQL(
      diffSchemas([], [keyed({ autoIncrement: true, defaultValue: '"APP"."ISEQ$$_1".nextval' })]),
      "oracle",
    );
    expect(sql).toContain('"id" int GENERATED BY DEFAULT AS IDENTITY NOT NULL,');
    expect(sql).not.toContain("ISEQ$$_1");
  });

  test("PostgreSQL writes an identity column as one, and keeps a sequence default as the default", () => {
    expect(generateMigrationSQL(diffSchemas([], [keyed({ autoIncrement: true })]), "postgres")).toContain(
      '"id" int GENERATED BY DEFAULT AS IDENTITY NOT NULL,',
    );
    const serial = generateMigrationSQL(
      diffSchemas([], [keyed({ autoIncrement: true, defaultValue: "nextval('app.t_id_seq'::regclass)" })]),
      "postgres",
    );
    expect(serial).toContain(`"id" int NOT NULL DEFAULT nextval('app.t_id_seq'::regclass),`);
    expect(serial).not.toContain("IDENTITY");
  });

  test("an added column keeps it too", () => {
    const before = table(["app", "t"], [column("note")]);
    const sql = generateMigrationSQL(diffSchemas([before], [keyed({ autoIncrement: true })]), "mysql");
    expect(sql).toContain("ALTER TABLE `app`.`t` ADD COLUMN `id` int AUTO_INCREMENT NOT NULL;");
  });

  test("a column the provider read as not auto-numbered, or did not read, is written as before", () => {
    for (const extra of [{ autoIncrement: false }, {}]) {
      const sql = generateMigrationSQL(diffSchemas([], [keyed(extra)]), "mysql");
      expect(sql).toContain("`id` int NOT NULL,");
      expect(sql).not.toContain("AUTO_INCREMENT");
    }
  });

  test("the diff carries the property on an added column", () => {
    const diff = diffSchemas([table(["app", "t"], [column("note")])], [keyed({ autoIncrement: true })]);
    expect(diff.tables[0].columns.find((c) => c.columnName === "id")?.targetAutoIncrement).toBe(true);
    const created = diffSchemas([], [keyed({ autoIncrement: true })]);
    expect(created.tables[0].columns[0].targetAutoIncrement).toBe(true);
    expect(created.tables[0].columns[1].targetAutoIncrement).toBeUndefined();
  });
});

// ============================================================================
// What a PostgreSQL table needs before it can be created (R9)
// ============================================================================

describe("generateMigrationSQL: PostgreSQL schemas, sequences and generated columns (R9)", () => {
  /**
   * Measured on PostgreSQL 19.0, replaying a 51-table migration into an empty database: every `nextval('app.x_seq')`
   * default failed with `relation "app.x_seq" does not exist`, the schemas had to be created by hand first, and the
   * generated column `vt` was written `DEFAULT (a * 3)`, which is `cannot use column reference in DEFAULT expression`.
   */
  const anchor = table(["app", "anchor"], [column("id")]);

  test("the schema of a new table is created first, once", () => {
    const sql = generateMigrationSQL(
      diffSchemas([anchor], [anchor, table(["sales", "a"], [column("id")]), table(["sales", "b"], [column("id")])]),
      "postgres",
    );
    expect(sql.match(/CREATE SCHEMA IF NOT EXISTS "sales";/g)).toHaveLength(1);
    expect(at(sql, 'CREATE SCHEMA IF NOT EXISTS "sales";')).toBeLessThan(at(sql, 'CREATE TABLE "sales"."a"'));
  });

  test("the sequence a new column's default draws from is created first", () => {
    const serial = table(
      ["app", "t"],
      [column("id", { autoIncrement: true, nullable: false, defaultValue: "nextval('app.\"T_id_seq\"'::regclass)" })],
    );
    const sql = generateMigrationSQL(diffSchemas([anchor], [anchor, serial]), "postgres");
    expect(at(sql, 'CREATE SEQUENCE IF NOT EXISTS app."T_id_seq";')).toBeLessThan(at(sql, 'CREATE TABLE "app"."t"'));
    // A column added to an existing table needs it too.
    const added = generateMigrationSQL(
      diffSchemas(
        [anchor, table(["app", "t"], [column("note")])],
        [anchor, table(["app", "t"], [column("note"), ...serial.columns])],
      ),
      "postgres",
    );
    expect(at(added, 'CREATE SEQUENCE IF NOT EXISTS app."T_id_seq";')).toBeLessThan(at(added, "ADD COLUMN"));
  });

  test("a default that is not a plain sequence call, or names no identifier, creates nothing", () => {
    for (const defaultValue of [
      "now()",
      "nextval('x'' ; DROP TABLE y; --'::regclass)",
      "(nextval('a.b'::regclass) + 1)",
    ]) {
      const sql = generateMigrationSQL(
        diffSchemas([anchor], [anchor, table(["app", "t"], [column("id", { defaultValue })])]),
        "postgres",
      );
      expect(sql).not.toContain("CREATE SEQUENCE");
    }
  });

  test("a table with no schema needs none", () => {
    const sql = generateMigrationSQL(diffSchemas([], [table(["t"], [column("id")])]), "postgres");
    expect(sql).not.toContain("CREATE SCHEMA");
  });

  test("a generated column is written as one, stored or virtual", () => {
    const sql = generateMigrationSQL(
      diffSchemas(
        [anchor],
        [
          anchor,
          table(
            ["app", "t"],
            [
              column("a"),
              column("vt", { defaultValue: "(a * 3)", generated: "stored" }),
              column("vv", { defaultValue: "(a + 1)", generated: "virtual" }),
            ],
          ),
        ],
      ),
      "postgres",
    );
    expect(sql).toContain('"vt" int GENERATED ALWAYS AS ((a * 3)) STORED');
    expect(sql).toContain('"vv" int GENERATED ALWAYS AS ((a + 1)) VIRTUAL');
    expect(sql).not.toContain("DEFAULT (a * 3)");
  });

  test("the diff carries a generated column's kind", () => {
    const diff = diffSchemas(
      [],
      [table(["app", "t"], [column("vt", { defaultValue: "(a * 3)", generated: "stored" })])],
    );
    expect(diff.tables[0].columns[0].targetGenerated).toBe("stored");
  });

  test("other engines are not handed a schema or a sequence", () => {
    const sql = generateMigrationSQL(diffSchemas([anchor], [anchor, table(["sales", "a"], [column("id")])]), "mysql");
    expect(sql).not.toContain("CREATE SCHEMA");
  });
});
