/**
 * The Db2 result mapping (#786).
 *
 * Every driver shape below was measured through db2-node against Db2 LUW 12.1.0.0: the `typeName`
 * spellings (`Integer`, `VarChar(50)`, `Decimal { precision: 9, scale: 2 }`, `Xml`), the GRAPHIC
 * columns that alone carry a `db2TypeName`, and the duplicate column name the driver lists twice
 * and keys once on 1.0.22 and 1.0.24; the CLOB that 1.0.24 describes as `VarChar(32777)` (a
 * `CLOB(1M)` table column, a `CLOB(2G)` cast and `SYSCAT.VIEWS.TEXT` all did, while a `CLOB(1K)`
 * cast answered `CLOB`), on 1.0.24.
 */

import { describe, expect, test } from "bun:test";
import type { Db2ColumnMeta, Db2QueryResult } from "@/lib/db/providers/sql/db2/driver";
import { db2TypeName, readResult } from "@/lib/db/providers/sql/db2/values";

function column(name: string, typeName: string, extra: Partial<Db2ColumnMeta> = {}): Db2ColumnMeta {
  return { name, typeName, nullable: true, ...extra };
}

function result(overrides: Partial<Db2QueryResult> = {}): Db2QueryResult {
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
    const read = readResult(result({ columns: [column("ID", "Integer"), column("NAME", "VarChar(10)")] }));

    expect(read.fields).toEqual(["ID", "NAME"]);
    expect(read.rows).toEqual([]);
    expect(read.rowCount).toBe(0);
    expect(read.columnTypes).toEqual({ ID: "INTEGER", NAME: "VARCHAR(10)" });
    expect(read.warnings).toBeUndefined();
  });

  test("a result set counts its rows, whatever rowCount the driver answered", () => {
    const rows = [{ ID: 1 }, { ID: 2 }];
    const read = readResult(result({ columns: [column("ID", "Integer")], rows, rowCount: 99 }));

    expect(read.rows).toBe(rows);
    expect(read.rowCount).toBe(2);
  });

  test("a DML statement reports the driver's count of changed rows", () => {
    const read = readResult(result({ rowCount: 3 }));

    expect(read.fields).toEqual([]);
    expect(read.rowCount).toBe(3);
    expect(read.columnTypes).toBeUndefined();
    expect(read.warnings).toBeUndefined();
  });

  // db2-node 1.0.24 reads SQLERRD3, so an UPDATE that matched nothing answers 0 (K19, fixed).
  test("a DML statement that changed no row reports zero", () => {
    expect(readResult(result({ rowCount: 0 })).rowCount).toBe(0);
  });

  test("M7: a duplicated column name is named in a warning, once per name", () => {
    const read = readResult(
      result({
        columns: [column("A", "Integer"), column("A", "Integer"), column("B", "Integer"), column("A", "Integer")],
        rows: [{ A: 2, B: 3 }],
      }),
    );

    expect(read.fields).toEqual(["A", "A", "B", "A"]);
    expect(read.warnings).toEqual([
      {
        message:
          "Db2 returned more than one column named A; db2-node keys rows by column name, so only the last value is shown. Give each column its own alias.",
      },
    ]);
  });

  test("the driver's own diagnostics are passed through as warnings", () => {
    const read = readResult(result({ rowCount: 1, diagnostics: ["SQLSTATE 01003: null values were eliminated"] }));

    expect(read.warnings).toEqual([{ message: "SQLSTATE 01003: null values were eliminated" }]);
  });

  // Measured on 12.1.0.0 through 1.0.24 (K4): `C_CLOB, C_BLOB` answered the CLOB's bytes as the
  // BLOB, `C_GRAPH, C_CLOB` answered no row of three, `C_DBL, C_CLOB` failed with a protocol
  // error, and `SELECT *` over APP.ALLTYPES answered one row of three; each LOB read on its own
  // was exact.
  test("a LOB or XML column beside another column carries an integrity warning naming them", () => {
    const read = readResult(
      result({
        columns: [
          column("ID", "Integer"),
          column("C_CLOB", "VarChar(32777)"),
          column("C_DBCLOB", "DBCLOB"),
          column("C_BLOB", "BLOB"),
          column("C_XML", "Xml"),
        ],
        rows: [{ ID: 1 }],
      }),
    );

    expect(read.warnings).toEqual([
      {
        message:
          "This result may not be what Db2 stored: db2-node can return wrong values, or drop rows, when a LOB or " +
          "XML column is read beside other columns, here C_CLOB (CLOB), C_DBCLOB (DBCLOB), C_BLOB (BLOB), C_XML " +
          "(XML). Select each of them on its own to read it exactly (K4). Exported or copied rows carry the same values.",
      },
    ]);
  });

  test("a LOB or XML column read on its own carries no warning, and neither does a result without one", () => {
    expect(readResult(result({ columns: [column("C_CLOB", "CLOB")] })).warnings).toBeUndefined();
    expect(
      readResult(
        result({
          columns: [column("C_BIG", "BigInt"), column("C_DECF", "DecFloat(34)"), column("C_BOOL", "Boolean")],
        }),
      ).warnings,
    ).toBeUndefined();
  });

  test("warnings keep their order: integrity, duplicates, then the driver's", () => {
    const read = readResult(
      result({
        columns: [column("X", "Xml"), column("X", "Xml")],
        diagnostics: ["driver says"],
      }),
    );

    expect(read.warnings).toHaveLength(3);
    expect(read.warnings?.[0]?.message).toContain("here X (XML).");
    expect(read.warnings?.[1]?.message).toContain("more than one column named X");
    expect(read.warnings?.[2]).toEqual({ message: "driver says" });
  });
});
