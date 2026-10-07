/**
 * The Db2 result mapping (#786).
 *
 * Every driver shape below was measured through db2-node against Db2 LUW 12.1.0.0: the `typeName`
 * spellings (`Integer`, `VarChar(50)`, `Decimal { precision: 9, scale: 2 }`, `Xml`), the GRAPHIC
 * columns that alone carry a `db2TypeName`, and the duplicate column name the driver lists twice
 * and keys once in an object row on 1.0.22 to 1.0.25, and keeps as two values in an array row on
 * 1.0.25 (K15); the CLOB that 1.0.24 describes as `VarChar(32777)` (a
 * `CLOB(1M)` table column, a `CLOB(2G)` cast and `SYSCAT.VIEWS.TEXT` all did, while a `CLOB(1K)`
 * cast answered `CLOB`), on 1.0.24.
 */

import { describe, expect, test } from "bun:test";
import type { Db2ArrayQueryResult, Db2ColumnMeta } from "@/lib/db/providers/sql/db2/driver";
import { DB2_PREVIEW_PROJECTION, db2TypeName, readResult } from "@/lib/db/providers/sql/db2/values";
import { QueryError } from "@/lib/db/errors";

/** The statement each result below answers; a refusal carries it. */
const SQL = "SELECT * FROM APP.T";

function column(name: string, typeName: string, extra: Partial<Db2ColumnMeta> = {}): Db2ColumnMeta {
  return { name, typeName, nullable: true, ...extra };
}

function result(overrides: Partial<Db2ArrayQueryResult> = {}): Db2ArrayQueryResult {
  return { rows: [], rowCount: 0, columns: [], diagnostics: [], ...overrides };
}

describe("db2TypeName", () => {
  test.each([
    ["BigInt", "BIGINT"],
    ["SmallInt", "SMALLINT"],
    ["Integer", "INTEGER"],
    ["Real", "REAL"],
    ["Double", "DOUBLE"],
    ["Date", "DATE"],
    ["Time", "TIME"],
    ["Timestamp", "TIMESTAMP"],
    ["Boolean", "BOOLEAN"],
    ["Char(10)", "CHAR(10)"],
    ["CHAR(5)", "CHAR(5)"],
    ["VarChar(50)", "VARCHAR(50)"],
    ["VARCHAR(20)", "VARCHAR(20)"],
    ["Binary(4)", "BINARY(4)"],
    ["VarBinary(16)", "VARBINARY(16)"],
    ["DecFloat(34)", "DECFLOAT(34)"],
    ["DecFloat(16)", "DECFLOAT(16)"],
    ["Decimal { precision: 31, scale: 8 }", "DECIMAL(31,8)"],
    ["Decimal { precision: 9, scale: 2 }", "DECIMAL(9,2)"],
    ["CLOB", "CLOB"],
    ["DBCLOB", "DBCLOB"],
    ["BLOB", "BLOB"],
    ["Xml", "XML"],
    ["XML", "XML"],
  ])("the driver's %p reads as Db2's %p", (typeName, expected) => {
    expect(db2TypeName(column("C", typeName))).toBe(expected);
  });

  test("a VARCHAR longer than Db2 allows one is the CLOB the driver described as one", () => {
    expect(db2TypeName(column("C", "VarChar(32777)"))).toBe("CLOB");
    expect(db2TypeName(column("C", "VarChar(32673)"))).toBe("CLOB");
    expect(db2TypeName(column("C", "VarChar(32672)"))).toBe("VARCHAR(32672)");
  });

  test("a db2TypeName the driver supplies wins over the mapping", () => {
    expect(db2TypeName(column("G", "CHAR(5)", { db2TypeName: "GRAPHIC(5)" }))).toBe("GRAPHIC(5)");
  });

  test("a spelling the mapping does not know is shown verbatim, for display only", () => {
    expect(db2TypeName(column("U", "Rowid"))).toBe("Rowid");
  });
});

describe("readResult", () => {
  test("fields come from the columns even when no row came back", () => {
    const read = readResult(result({ columns: [column("ID", "Integer"), column("NAME", "VarChar(10)")] }), SQL);

    expect(read.fields).toEqual(["ID", "NAME"]);
    expect(read.rows).toEqual([]);
    expect(read.rowCount).toBe(0);
    expect(read.columnTypes).toEqual({ ID: "INTEGER", NAME: "VARCHAR(10)" });
    expect(read.warnings).toBeUndefined();
  });

  test("a result set counts its rows, whatever rowCount the driver answered, and keys each array row by column", () => {
    const read = readResult(result({ columns: [column("ID", "Integer")], rows: [[1], [2]], rowCount: 99 }), SQL);

    expect(read.rows).toEqual([{ ID: 1 }, { ID: 2 }]);
    expect(read.rowCount).toBe(2);
  });

  test("a DML statement reports the driver's count of changed rows", () => {
    const read = readResult(result({ rowCount: 3 }), SQL);

    expect(read.fields).toEqual([]);
    expect(read.rowCount).toBe(3);
    expect(read.columnTypes).toBeUndefined();
    expect(read.warnings).toBeUndefined();
  });

  // db2-node 1.0.24 reads SQLERRD3, so an UPDATE that matched nothing answers 0 (K19, fixed).
  test("a DML statement that changed no row reports zero", () => {
    expect(readResult(result({ rowCount: 0 }), SQL).rowCount).toBe(0);
  });

  // Measured on 12.1.0.0 and 11.5.9.0 through 1.0.25: `SELECT 1 AS A, 2 AS A` answers the array
  // row [1, 2] under `rowMode: "array"` and the object row {A: 2} without it (K15, fixed).
  test("a duplicated column name keeps every value, the repeats numbered as Druid and Trino number them", () => {
    const read = readResult(
      result({
        columns: [column("A", "Integer"), column("A", "Integer"), column("B", "Integer"), column("A", "BigInt")],
        rows: [[1, 2, 3, 4]],
      }),
      SQL,
    );

    expect(read.fields).toEqual(["A", "A (2)", "B", "A (3)"]);
    expect(read.rows).toEqual([{ A: 1, "A (2)": 2, B: 3, "A (3)": 4 }]);
    expect(read.columnTypes).toEqual({ A: "INTEGER", "A (2)": "INTEGER", B: "INTEGER", "A (3)": "BIGINT" });
    expect(read.warnings).toBeUndefined();
  });

  test("the numbering skips a name the statement already used", () => {
    const read = readResult(
      result({
        columns: [column("A", "Integer"), column("A (2)", "Integer"), column("A", "Integer")],
        rows: [[1, 2, 3]],
      }),
      SQL,
    );

    expect(read.fields).toEqual(["A", "A (2)", "A (3)"]);
    expect(read.rows).toEqual([{ A: 1, "A (2)": 2, "A (3)": 3 }]);
  });

  test("the numbering skips a name the statement declares later", () => {
    const read = readResult(
      result({
        columns: [column("A", "Integer"), column("A", "BigInt"), column("A (2)", "Integer")],
        rows: [[1, 2, 3]],
      }),
      SQL,
    );

    expect(read.fields).toEqual(["A", "A (3)", "A (2)"]);
    expect(read.rows).toEqual([{ A: 1, "A (3)": 2, "A (2)": 3 }]);
    expect(read.columnTypes).toEqual({ A: "INTEGER", "A (3)": "BIGINT", "A (2)": "INTEGER" });
  });

  // A row whose value count differs from the declaration cannot be read by position: a short
  // one would carry `undefined` values and a long one would lose its tail, both silently.
  test.each<[string, unknown[]]>([
    ["short", [1]],
    ["long", [1, 2, 3]],
  ])("a %s row is refused rather than read by position", (_label, row) => {
    let refused: unknown;
    try {
      readResult(result({ columns: [column("A", "Integer"), column("B", "Integer")], rows: [row] }), SQL);
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(QueryError);
    expect((refused as QueryError).message).toBe(`Row 1 carries ${row.length} values for 2 result columns`);
    expect((refused as QueryError).query).toBe(SQL);
  });

  test("the driver's own diagnostics are passed through as warnings", () => {
    const read = readResult(result({ rowCount: 1, diagnostics: ["SQLSTATE 01003: null values were eliminated"] }), SQL);

    expect(read.warnings).toEqual([{ message: "SQLSTATE 01003: null values were eliminated" }]);
  });

  // Measured on 12.1.0.0 and 11.5.9.0 through 1.0.25 (K4, fixed): `SELECT *` over APP.ALLTYPES
  // and every mixed read of a CLOB(1M) beside a GRAPHIC, a DOUBLE, a BLOB and XML, NULL LOB rows
  // and a 50000-byte CLOB included, answered what each column read alone answers.
  test("a LOB or XML column beside other columns carries no integrity warning", () => {
    const read = readResult(
      result({ columns: [column("ID", "Integer"), column("C_XML", "Xml"), column("C_VCHAR", "VarChar(50)")] }),
      SQL,
    );
    expect(read.warnings).toBeUndefined();
  });

  // Measured on 12.1.0.0 and 11.5.9.0 through 1.0.24 and 1.0.25 (K24): a value bound to a CLOB,
  // DBCLOB or BLOB column declared 32768 bytes or longer answers 0 changed rows, no error, and is
  // not written, which is what the grid's inline editor sends for such a cell.
  test("a CLOB, DBCLOB or BLOB column carries one warning that the grid does not edit it", () => {
    const read = readResult(
      result({
        columns: [
          column("ID", "Integer"),
          column("C_CLOB", "VarChar(32777)"),
          column("C_DBCLOB", "DBCLOB"),
          column("C_BLOB", "BLOB"),
          column("C_XML", "Xml"),
        ],
      }),
      SQL,
    );

    expect(read.warnings).toEqual([
      {
        message:
          "The grid does not edit C_CLOB (CLOB), C_DBCLOB (DBCLOB), C_BLOB (BLOB) inline: db2-node writes nothing, " +
          "and reports no error, for a value bound to a CLOB, DBCLOB or BLOB column declared 32768 bytes or longer " +
          "(K24). Change such a value with an UPDATE of your own that writes it as a literal.",
      },
    ]);
  });

  test("the LOB warning comes before the driver's diagnostics, and a LOB alone carries it too", () => {
    const read = readResult(result({ columns: [column("B", "BLOB")], diagnostics: ["driver says"] }), SQL);

    expect(read.warnings).toHaveLength(2);
    expect(read.warnings?.[0]?.message).toContain("does not edit B (BLOB) inline");
    expect(read.warnings?.[1]).toEqual({ message: "driver says" });
  });
});

describe("DB2_PREVIEW_PROJECTION", () => {
  // The grid's editor refuses a CLOB, DBCLOB or BLOB column (K24), so a preview that reads every
  // column says the editor does not take one rather than that an edit of it is lost.
  test("a preview without its column list says the grid does not edit a LOB column", () => {
    expect(DB2_PREVIEW_PROJECTION.unprojectedNote).toBe(
      "The column list is not loaded, so this reads every column; the grid does not edit a CLOB, DBCLOB or BLOB " +
        "column inline (docs/providers/db2.md, K24).",
    );
  });
});
