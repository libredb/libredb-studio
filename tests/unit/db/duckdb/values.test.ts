/**
 * Unit tests for the DuckDB result mapping (issue #424).
 *
 * Every fixture below is a shape MEASURED against DuckDB v1.5.5 through
 * @duckdb/node-api 1.5.5-r.4 on 2026-08-27 and recorded in `.duckdb-measured.md` -
 * the human size strings, the decimal-string BIGINTs, the synthetic `Count` column.
 * The integration suite proves the engine still produces them; these tests prove the
 * mapping reads them correctly, including the shapes that are awkward to provoke live.
 */

import { describe, expect, test } from "bun:test";
import type { DuckDBStatementResult } from "@/lib/db/providers/sql/duckdb/client";
import {
  columnTypeMap,
  isWriteAcknowledgement,
  parseDuckDBSize,
  readCount,
  toQueryResult,
} from "@/lib/db/providers/sql/duckdb/values";

function statementResult(overrides: Partial<DuckDBStatementResult> = {}): DuckDBStatementResult {
  return { columnNames: [], columnTypes: [], rows: [], rowsChanged: 0, ...overrides };
}

describe("isWriteAcknowledgement", () => {
  test("an INSERT's single Count column is the engine acknowledging a write", () => {
    const result = statementResult({
      columnNames: ["Count"],
      columnTypes: ["BIGINT"],
      rows: [{ Count: "2" }],
      rowsChanged: 2,
    });

    expect(isWriteAcknowledgement(result, "INSERT")).toBe(true);
  });

  test("a CREATE TABLE declares Count and returns no rows at all", () => {
    const result = statementResult({ columnNames: ["Count"], columnTypes: ["BIGINT"] });

    expect(isWriteAcknowledgement(result, "CREATE")).toBe(true);
  });

  test("a SELECT the user aliased to Count is NOT swallowed", () => {
    const result = statementResult({
      columnNames: ["Count"],
      columnTypes: ["BIGINT"],
      rows: [{ Count: "41" }],
    });

    expect(isWriteAcknowledgement(result, "SELECT")).toBe(false);
  });

  test.each(["FROM", "WITH", "CALL", "SUMMARIZE", "PIVOT", "UNPIVOT", "VALUES", "TABLE", "PRAGMA", "EXECUTE"])(
    "%s is a row-producing form, so its Count column is data",
    (keyword) => {
      const result = statementResult({ columnNames: ["Count"], rows: [{ Count: "1" }] });

      expect(isWriteAcknowledgement(result, keyword)).toBe(false);
    },
  );

  test("an unreadable leading keyword keeps the result exactly as the engine sent it", () => {
    // Nothing is swallowed on a guess: `undefined` means the statement opened with
    // something the keyword reader could not name - a parenthesised `(SELECT 1 AS Count)`
    // is the measured case, and it answers a real row. Only a keyword that WAS read and
    // is not row-producing may swallow a result.
    const result = statementResult({ columnNames: ["Count"], rows: [{ Count: "1" }] });

    expect(isWriteAcknowledgement(result, undefined)).toBe(false);
  });

  test("a two-column result is never an acknowledgement", () => {
    const result = statementResult({ columnNames: ["Count", "other"], rows: [] });

    expect(isWriteAcknowledgement(result, "INSERT")).toBe(false);
  });

  test("a single column that is not Count is never an acknowledgement", () => {
    // `EXPORT DATABASE` answers a `Success` column; it is a projection, not a count.
    const result = statementResult({ columnNames: ["Success"], rows: [] });

    expect(isWriteAcknowledgement(result, "EXPORT")).toBe(false);
  });

  // Every statement below was run against DuckDB v1.5.5 on 2026-08-27: each one answers
  // a single column named `Count` carrying DATA, and the keyword beside it is what
  // `readLeadingKeyword` reads off that text. Discarding any of them loses the
  // operator's result outright, which is why an unread opener may never swallow one.
  test.each([
    ["SELECT 1 AS Count", "SELECT"],
    [`SELECT count(*) AS "Count" FROM customers`, "SELECT"],
    [`SELECT "Count" FROM tally`, "SELECT"],
    ["FROM customers SELECT count(*) AS Count", "FROM"],
    ["-- a note\nSELECT 1 AS Count", "SELECT"],
    ["/* note */ SELECT count(*) AS Count FROM tally", "SELECT"],
    ["   SELECT 1 AS Count", "SELECT"],
    [`WITH "Count" AS (SELECT 1 AS c) SELECT c AS Count FROM "Count"`, "WITH"],
    ["(SELECT 1 AS Count)", undefined],
    ["EXECUTE p", "EXECUTE"],
  ])("%s is a result, not an acknowledgement", (_sql, keyword) => {
    const result = statementResult({ columnNames: ["Count"], columnTypes: ["BIGINT"], rows: [{ Count: "1" }] });

    expect(isWriteAcknowledgement(result, keyword)).toBe(false);
  });

  // The other side of the same measurement: these answered `Count` as an acknowledgement,
  // with the row count in `rowsChanged`.
  test.each([
    ["INSERT INTO tally VALUES (1)", "INSERT"],
    ["UPDATE tally SET a = 3 WHERE a = 2", "UPDATE"],
    ["DELETE FROM tally WHERE a = 3", "DELETE"],
    ["COPY tally TO '/tmp/tally.csv'", "COPY"],
    ["CREATE TABLE t (a INTEGER)", "CREATE"],
  ])("%s is the engine acknowledging a write", (_sql, keyword) => {
    const result = statementResult({ columnNames: ["Count"], rows: [{ Count: "1" }], rowsChanged: 1 });

    expect(isWriteAcknowledgement(result, keyword)).toBe(true);
  });
});

describe("columnTypeMap", () => {
  test("pairs every declared type with its column name", () => {
    const result = statementResult({
      columnNames: ["a", "v", "big"],
      columnTypes: ["INTEGER", "VARCHAR", "HUGEINT"],
    });

    expect(columnTypeMap(result)).toEqual({ a: "INTEGER", v: "VARCHAR", big: "HUGEINT" });
  });

  test("a column with no declared type is left out rather than given an empty one", () => {
    const result = statementResult({ columnNames: ["a", "b"], columnTypes: ["INTEGER"] });

    expect(columnTypeMap(result)).toEqual({ a: "INTEGER" });
  });

  test("duplicate column names collapse to the last, exactly as the row objects do", () => {
    const result = statementResult({ columnNames: ["a", "a"], columnTypes: ["INTEGER", "VARCHAR"] });

    expect(columnTypeMap(result)).toEqual({ a: "VARCHAR" });
  });
});

describe("toQueryResult", () => {
  test("a write reports the changed rows and shows no grid", () => {
    const result = statementResult({
      columnNames: ["Count"],
      columnTypes: ["BIGINT"],
      rows: [{ Count: "2" }],
      rowsChanged: 2,
    });

    expect(toQueryResult(result, 4, "INSERT")).toEqual({ rows: [], fields: [], rowCount: 2, executionTime: 4 });
  });

  test("a DELETE that matched nothing reports zero, not the acknowledgement row", () => {
    const result = statementResult({ columnNames: ["Count"], rows: [{ Count: "0" }], rowsChanged: 0 });

    expect(toQueryResult(result, 1, "DELETE")).toEqual({ rows: [], fields: [], rowCount: 0, executionTime: 1 });
  });

  test("a statement whose opener could not be read is shown exactly as the engine sent it", () => {
    // Measured: `(SELECT 1 AS Count)` answers `[{"Count":1}]` and opens with a
    // parenthesis, so no leading keyword is readable. Dropping those rows would hand the
    // operator an empty grid over a real result; a one-cell grid is the cheaper error.
    const result = statementResult({ columnNames: ["Count"], columnTypes: ["INTEGER"], rows: [{ Count: 1 }] });

    expect(toQueryResult(result, 2, undefined)).toEqual({
      rows: [{ Count: 1 }],
      fields: ["Count"],
      rowCount: 1,
      executionTime: 2,
      columnTypes: { Count: "INTEGER" },
    });
  });

  test("a read carries its rows, its declared columns and its types", () => {
    const result = statementResult({
      columnNames: ["id", "name"],
      columnTypes: ["INTEGER", "VARCHAR"],
      rows: [{ id: 1, name: "Ada" }],
    });

    expect(toQueryResult(result, 7, "SELECT")).toEqual({
      rows: [{ id: 1, name: "Ada" }],
      fields: ["id", "name"],
      rowCount: 1,
      executionTime: 7,
      columnTypes: { id: "INTEGER", name: "VARCHAR" },
    });
  });

  test("an empty row set keeps the columns the engine declared for it", () => {
    // `columnNames()` answers on an empty result and `getRowObjectsJson()` does not,
    // which is why the columns can never come from the first row.
    const result = statementResult({ columnNames: ["id"], columnTypes: ["INTEGER"], rows: [] });

    expect(toQueryResult(result, 0, "SELECT")).toEqual({
      rows: [],
      fields: ["id"],
      rowCount: 0,
      executionTime: 0,
      columnTypes: { id: "INTEGER" },
    });
  });

  test("a statement projecting nothing omits columnTypes rather than sending an empty object", () => {
    const mapped = toQueryResult(statementResult(), 0, "SELECT");

    expect(mapped).toEqual({ rows: [], fields: [], rowCount: 0, executionTime: 0 });
    expect("columnTypes" in mapped).toBe(false);
  });
});

describe("parseDuckDBSize", () => {
  // Exactly the strings `pragma_database_size()` was measured producing.
  test.each([
    ["2.0 MiB", 2097152],
    ["0 bytes", 0],
    ["512.0 KiB", 524288],
    ["50.0 GiB", 53687091200],
    ["3.2 MiB", 3355443],
    ["1 byte", 1],
    ["1.0 TiB", 1099511627776],
    ["1.0 PiB", 1125899906842624],
    ["262144bytes", 262144],
  ])("%s parses to %i bytes", (text, bytes) => {
    expect(parseDuckDBSize(text)).toBe(bytes);
  });

  test.each([
    ["", "an empty string"],
    ["MiB", "a unit with no number"],
    ["2.0", "a number with no unit"],
    ["2.0 furlongs", "a unit DuckDB does not use"],
    ["2,0 MiB", "a locale-formatted number"],
    ["-1 MiB", "a negative size"],
  ])("%s is absent (%s), never zero", (text) => {
    expect(parseDuckDBSize(text)).toBeUndefined();
  });

  test.each([[null], [undefined], [42], [{}]])("a non-string reading (%p) is absent", (value) => {
    expect(parseDuckDBSize(value)).toBeUndefined();
  });
});

describe("readCount", () => {
  test("a BIGINT arriving as a decimal string is read as a number", () => {
    expect(readCount("262144")).toBe(262144);
    expect(readCount("0")).toBe(0);
  });

  test("a count past 2^53 loses precision, which is why only COUNTS are read this way", () => {
    // Every catalog figure this reader is pointed at - a row count, a block count, a
    // block size - is far inside the safe range. A user's own BIGINT column never comes
    // through here: `toQueryResult` hands those to the caller as the decimal STRINGS
    // `getRowObjectsJson()` produced, precision intact.
    expect(readCount(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
    expect(readCount("9223372036854775807")).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
  });

  test("a number is taken as it stands", () => {
    expect(readCount(5)).toBe(5);
  });

  test.each([[null], [undefined], [{}], [true], ["not a number"], [Number.POSITIVE_INFINITY]])(
    "a non-reading (%p) is absent rather than zero",
    (value) => {
      expect(readCount(value)).toBeUndefined();
    },
  );
});
