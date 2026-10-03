/**
 * The Db2 result mapping (#786).
 *
 * Every driver shape below was measured through db2-node 1.0.22 against Db2 LUW 12.1.0.0: the
 * `typeName` spellings (`Integer`, `VarChar(50)`, `Decimal { precision: 9, scale: 2 }`, `Xml`),
 * the GRAPHIC columns that alone carry a `db2TypeName`, the row count of -2147221503 a searched
 * UPDATE or DELETE that matched no row answers, and the duplicate column name the driver lists
 * twice and keys once.
 */

import { describe, expect, test } from "bun:test";
import type { Db2ColumnMeta, Db2QueryResult } from "@/lib/db/providers/sql/db2/driver";
import { DML_NO_ROW_SENTINEL, db2TypeName, readResult } from "@/lib/db/providers/sql/db2/values";

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

  test("the no-row sentinel of a searched UPDATE or DELETE reads as zero rows", () => {
    expect(DML_NO_ROW_SENTINEL).toBe(-2147221503);
    const read = readResult(result({ rowCount: DML_NO_ROW_SENTINEL }));

    expect(read.rowCount).toBe(0);
    expect(read.warnings).toBeUndefined();
  });

  test("any other negative count is reported as zero and named in a warning, never passed on", () => {
    const read = readResult(result({ rowCount: -5 }));

    expect(read.rowCount).toBe(0);
    expect(read.warnings).toEqual([
      {
        message:
          "db2-node reported -5 changed rows, which is not a row count; the statement ran, and how many rows it changed is unknown.",
      },
    ]);
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

  test("a column of a type the driver is known to misread carries an integrity warning", () => {
    const read = readResult(
      result({
        columns: [
          column("ID", "Integer"),
          column("C_BIG", "BigInt"),
          column("C_DECF", "DecFloat(34)"),
          column("C_BOOL", "Boolean"),
          column("C_XML", "Xml"),
        ],
        rows: [{ ID: 1 }],
      }),
    );

    expect(read.warnings).toHaveLength(1);
    const warning = read.warnings?.[0]?.message ?? "";
    expect(warning).toContain("db2-node 1.0.22");
    expect(warning).toContain("C_BIG (BIGINT)");
    expect(warning).toContain("C_DECF (DECFLOAT(34))");
    expect(warning).toContain("C_BOOL (BOOLEAN)");
    expect(warning).toContain("C_XML (XML)");
    expect(warning).toContain("CHAR(");
    expect(warning).toContain("XMLSERIALIZE");
  });

  test("the integrity warning names only the defects its columns can have", () => {
    const warning = readResult(result({ columns: [column("C_BIG", "BigInt")], rows: [] })).warnings?.[0]?.message ?? "";

    expect(warning).toContain("C_BIG (BIGINT)");
    expect(warning).not.toContain("XMLSERIALIZE");
    expect(warning).not.toContain("DECFLOAT or BOOLEAN");
  });

  test("warnings keep their order: integrity, duplicates, then the driver's", () => {
    const read = readResult(
      result({
        columns: [column("X", "Xml"), column("X", "Xml")],
        diagnostics: ["driver says"],
      }),
    );

    expect(read.warnings).toHaveLength(3);
    expect(read.warnings?.[0]?.message).toContain("X (XML)");
    expect(read.warnings?.[1]?.message).toContain("more than one column named X");
    expect(read.warnings?.[2]).toEqual({ message: "driver says" });
  });
});
