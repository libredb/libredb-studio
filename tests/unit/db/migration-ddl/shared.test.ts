/**
 * The PostgreSQL-shaped building blocks every engine module shares by import, each pinned to the
 * text today's generator writes when it falls through to its PostgreSQL arm.
 */
import { describe, expect, test } from "bun:test";
import {
  BEGIN_COMMIT,
  NO_FOREIGN_KEY_CONSTRAINT,
  commentName,
  defaultSql,
  standardAddColumn,
  standardAddForeignKey,
  standardColumnDef,
  standardCreateIndex,
  standardCreateTableForeignKey,
  standardDropColumn,
  standardDropForeignKey,
  standardDropIndex,
  standardDropTable,
  standardModifyColumn,
  standardPrimaryKey,
} from "@/lib/db/migration-ddl/shared";
import type { ColumnDiff, ForeignKeyDdl, IndexDdl } from "@/lib/db/migration-ddl/types";

const FK: ForeignKeyDdl = { constraint: '"fk_t_d"', column: '"d"', references: '"u"("id")' };
const INDEX: IndexDdl = { name: '"i"', qualifiedName: '"s"."i"', unique: false, columns: [] };

describe("migration-ddl shared building blocks", () => {
  test("commentName turns every line break into a space", () => {
    expect(commentName("a\nb\rc\u2028d")).toBe("a b c d");
  });

  test("defaultSql prefers the engine's SQL, keeps an empty default, and is undefined with neither", () => {
    expect(defaultSql({ targetDefault: "abc", targetDefaultSql: "'abc'" } as ColumnDiff)).toBe("'abc'");
    expect(defaultSql({ targetDefault: "" } as ColumnDiff)).toBe("");
    expect(defaultSql({} as ColumnDiff)).toBeUndefined();
  });

  test("standardColumnDef writes type, nullability and default, falling back to TEXT", () => {
    expect(
      standardColumnDef(
        { columnName: "c", action: "added", changes: [], targetNullable: false, targetDefault: "1" },
        '"c"',
      ),
    ).toBe('"c" TEXT NOT NULL DEFAULT 1');
  });

  test("standardPrimaryKey goes inside the CREATE TABLE", () => {
    expect(standardPrimaryKey(['"id"'])).toEqual({ inside: ',  PRIMARY KEY ("id")' });
  });

  test("standardCreateTableForeignKey goes after the CREATE TABLE as an ADD CONSTRAINT", () => {
    expect(standardCreateTableForeignKey(FK, '"t"')).toEqual({
      after: 'ALTER TABLE "t" ADD CONSTRAINT "fk_t_d" FOREIGN KEY ("d") REFERENCES "u"("id");',
    });
  });

  test("the foreign-key statements", () => {
    expect(standardAddForeignKey(FK, '"t"')).toBe(
      'ALTER TABLE "t" ADD CONSTRAINT "fk_t_d" FOREIGN KEY ("d") REFERENCES "u"("id");',
    );
    expect(standardDropForeignKey('"fk_t_d"', '"t"')).toBe('ALTER TABLE "t" DROP CONSTRAINT IF EXISTS "fk_t_d";');
  });

  test("the index statements", () => {
    expect(standardDropIndex(INDEX, '"s"."t"')).toBe('DROP INDEX IF EXISTS "s"."i";');
    expect(standardCreateIndex({ ...INDEX, unique: true, columns: ['"a"', '"b"'] }, '"s"."t"')).toBe(
      'CREATE UNIQUE INDEX "i" ON "s"."t" ("a", "b");',
    );
    expect(standardCreateIndex({ ...INDEX, columns: ['"a"'] }, '"t"')).toBe('CREATE INDEX "i" ON "t" ("a");');
  });

  test("the column and table statements", () => {
    const col: ColumnDiff = { columnName: "c", action: "removed", changes: [] };
    expect(standardAddColumn('"c" TEXT', '"t"')).toBe('ALTER TABLE "t" ADD COLUMN "c" TEXT;');
    expect(standardDropColumn(col, '"c"', '"t"')).toBe('ALTER TABLE "t" DROP COLUMN "c";');
    expect(standardDropTable('"t"')).toBe('DROP TABLE IF EXISTS "t";');
  });

  test("standardModifyColumn writes one statement per changed facet", () => {
    const col: ColumnDiff = {
      columnName: "c",
      action: "modified",
      changes: [],
      sourceType: "int",
      targetType: "text",
      sourceNullable: true,
      targetNullable: false,
      sourceDefault: "1",
    };
    expect(standardModifyColumn(col, '"c"', '"t"')).toEqual([
      'ALTER TABLE "t" ALTER COLUMN "c" TYPE text;',
      'ALTER TABLE "t" ALTER COLUMN "c" SET NOT NULL;',
      'ALTER TABLE "t" ALTER COLUMN "c" DROP DEFAULT;',
    ]);
    expect(
      standardModifyColumn(
        { ...col, sourceType: "text", sourceNullable: false, targetNullable: true, targetDefault: "2" },
        '"c"',
        '"t"',
      ),
    ).toEqual(['ALTER TABLE "t" ALTER COLUMN "c" DROP NOT NULL;', 'ALTER TABLE "t" ALTER COLUMN "c" SET DEFAULT 2;']);
    expect(
      standardModifyColumn({ ...col, sourceType: "text", sourceNullable: false, targetDefault: "1" }, '"c"', '"t"'),
    ).toEqual([]);
  });

  test("the constants", () => {
    expect(BEGIN_COMMIT).toEqual({ begin: "BEGIN;", commit: "COMMIT;" });
    expect(NO_FOREIGN_KEY_CONSTRAINT).toBe("The engine has no foreign-key constraint.");
  });
});
