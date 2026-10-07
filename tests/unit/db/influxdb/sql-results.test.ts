/**
 * `shapeJsonlBody` (InfluxDB spec 3.4, 5.2 step 9, I9): a `/api/v3/query_sql` jsonl body to the fields and rows the
 * grid shows, over the 3.12.0 Core captures. Large integers stay exact strings, a key a line omits is a null cell, the
 * columns are the ordered union of keys in the order the lines name them, and the row cut and the cell budget set
 * `cut`.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { INFLUX_CELL_BUDGET, INFLUX_ROW_CUT } from "@/lib/db/providers/timeseries/influxdb/connection-options";
import { InfluxAnswerShapeError } from "@/lib/db/providers/timeseries/influxdb/errors";
import { shapeJsonlBody } from "@/lib/db/providers/timeseries/influxdb/sql-results";
import { loadInfluxCapture } from "../../../helpers/influxdb-fixtures";

const LIMITS = { rowCut: INFLUX_ROW_CUT, cellBudget: INFLUX_CELL_BUDGET };

function shapeCapture(name: string) {
  return shapeJsonlBody(loadInfluxCapture("3.12.0-core", name).body, LIMITS);
}

function shapeError(text: string): InfluxAnswerShapeError {
  try {
    shapeJsonlBody(text, LIMITS);
  } catch (error) {
    if (error instanceof InfluxAnswerShapeError) return error;
    throw error;
  }
  throw new Error("shapeJsonlBody did not throw");
}

describe("shapeJsonlBody over the 3.12.0 Core captures", () => {
  test("SELECT * keeps the engine's alphabetical order and the naive timestamp as text", () => {
    const shaped = shapeCapture("sql-preview-home");
    expect(shaped.fields).toEqual(["co", "hum", "room", "temp", "time"]);
    expect(shaped.rows).toEqual([{ co: 26, hum: 36.4, room: "Kitchen", temp: 22.2, time: "2026-10-04T01:50:41" }]);
    expect(shaped.cut).toBe(false);
    expect(shaped.warnings).toEqual([]);
  });

  test("an explicit projection keeps its own order", () => {
    expect(shapeCapture("sql-keyword-show-tables").fields).toEqual([
      "table_catalog",
      "table_schema",
      "table_name",
      "table_type",
    ]);
    expect(shapeCapture("sql-schema-home").fields).toEqual(["key", "data_type"]);
  });

  test("a sparse table appends late keys and fills omitted keys with null", () => {
    const shaped = shapeCapture("sql-sparse");
    expect(shaped.fields).toEqual(["a", "b", "id", "time", "c"]);
    expect(shaped.rows).toEqual([
      { a: 1, b: 2, id: "r1", time: "2022-01-01T08:00:00", c: null },
      { a: 3, b: null, id: "r2", time: "2022-01-01T08:00:01", c: null },
      { a: null, b: 4, id: "r3", time: "2022-01-01T08:00:02", c: "only c" },
    ]);
  });

  test("integers beyond 2^53 arrive as exact strings, nanoseconds and quotes as stored", () => {
    const shaped = shapeCapture("sql-edge");
    const byKind = (kind: string) => shaped.rows.filter((row) => row.kind === kind);
    expect(byKind("above-2-53")[0].v).toBe("9007199254740993");
    expect(byKind("int64-max")[0].v).toBe("9223372036854775807");
    expect(byKind("int64-min")[0].v).toBe("-9223372036854775808");
    expect(byKind("uint64-max")[0].u).toBe("18446744073709551615");
    expect(byKind("boolean")[0].b).toBe(true);
    expect(byKind("string")[0].s).toBe(`say "hi", it's a back\\slash`);
    expect(byKind("nanoseconds").map((row) => row.time)).toEqual([
      "2022-01-01T08:00:00.123456789",
      "2022-01-01T08:00:00.123456790",
    ]);
    expect(shaped.fields).toEqual(["kind", "time", "v", "b", "s", "u"]);
  });

  test.each([
    ["sql-keyword-select", ["Int64(1)"], [{ "Int64(1)": 1 }]],
    ["sql-keyword-with", ["count(*)"], [{ "count(*)": 26 }]],
    [
      "sql-keyword-values",
      ["column1", "column2"],
      [
        { column1: 1, column2: "a" },
        { column1: 2, column2: "b" },
      ],
    ],
  ])("%s keeps its projection's fields and rows", (name, fields, rows) => {
    const shaped = shapeCapture(name);
    expect(shaped.fields).toEqual(fields);
    expect(shaped.rows).toEqual(rows);
    expect(shaped.cut).toBe(false);
  });

  test("sql-keyword-describe is one row per column with the catalog's three fields", () => {
    const shaped = shapeCapture("sql-keyword-describe");
    expect(shaped.fields).toEqual(["column_name", "data_type", "is_nullable"]);
    expect(shaped.rows.map((row) => row.column_name)).toEqual(["co", "hum", "room", "temp", "time"]);
    expect(shaped.rows[4]).toEqual({ column_name: "time", data_type: "Timestamp(ns)", is_nullable: "NO" });
  });

  test("sql-keyword-explain keeps the escaped newlines inside a plan as real newlines", () => {
    const shaped = shapeCapture("sql-keyword-explain");
    expect(shaped.fields).toEqual(["plan_type", "plan"]);
    expect(shaped.rows.map((row) => row.plan_type)).toEqual(["logical_plan", "physical_plan"]);
    expect(shaped.rows[0].plan).toBe(
      "Projection: count(Int64(1)) AS count(*)\n  Aggregate: groupBy=[[]], aggr=[[count(Int64(1))]]\n    TableScan: home projection=[]",
    );
  });

  test("zero bytes is an empty result with no fields", () => {
    expect(shapeCapture("sql-empty")).toEqual({ fields: [], rows: [], cut: false, warnings: [] });
  });
});

describe("shapeJsonlBody, values and lines", () => {
  test("a null cell, which is how the SQL route writes a NaN (SPEC 3.4), stays null", () => {
    expect(shapeJsonlBody('{"v":null,"w":1}\n', LIMITS).rows).toEqual([{ v: null, w: 1 }]);
  });

  test("-0.0 parses to -0, which prints as 0", () => {
    const value = shapeJsonlBody('{"v":-0.0}\n', LIMITS).rows[0].v;
    expect(Object.is(value, -0)).toBe(true);
    expect(String(value)).toBe("0");
  });

  test("blank lines are skipped, and a last line without a newline is read", () => {
    const shaped = shapeJsonlBody('\n{"a":1}\n\n  \r\n{"a":2}', LIMITS);
    expect(shaped.rows).toEqual([{ a: 1 }, { a: 2 }]);
  });

  test("keys that look like array indices keep the order the line names them in", () => {
    const shaped = shapeJsonlBody('{"b":1,"1":2,"a":{"9":0,"x":[1,"}"]},"0":"\\"q"}\n{"2":3}\n', LIMITS);
    expect(shaped.fields).toEqual(["b", "1", "a", "0", "2"]);
    expect(shaped.rows[0]).toEqual({ b: 1, "1": 2, a: { "9": 0, x: [1, "}"] }, "0": '"q', "2": null });
  });

  test("an escaped key is read as its text, so its plain spelling repeats it", () => {
    expect(shapeJsonlBody('{"a\\u0062":1}\n', LIMITS).fields).toEqual(["ab"]);
    const error = shapeError('{"a\\u0062":1,"ab":2}\n');
    expect(error.fault).toBe("repeated-column");
    expect(error.serverText).toBe("ab");
  });

  test('an empty key, which 3.12 Core answers for SELECT 1 AS "", is named (No column name) on every row', () => {
    const shaped = shapeJsonlBody('{"":1,"a":2}\n{"a":3}\n', LIMITS);
    expect(shaped.fields).toEqual(["(No column name)", "a"]);
    expect(shaped.rows).toEqual([
      { "(No column name)": 1, a: 2 },
      { "(No column name)": null, a: 3 },
    ]);
  });

  test("a key a statement spells (No column name) stays apart from the empty one", () => {
    const shaped = shapeJsonlBody('{"(No column name)":1,"":2}\n', LIMITS);
    expect(shaped.fields).toEqual(["(No column name)", "(No column name) (2)"]);
    expect(shaped.rows).toEqual([{ "(No column name)": 1, "(No column name) (2)": 2 }]);
  });

  test("a column named __proto__ is an ordinary cell, never the row's prototype", () => {
    const shaped = shapeJsonlBody('{"__proto__":"x","a":1}\n{"a":2}\n', LIMITS);
    expect(shaped.fields).toEqual(["__proto__", "a"]);
    expect(Object.hasOwn(shaped.rows[0], "__proto__")).toBe(true);
    expect(shaped.rows[0].__proto__).toBe("x");
    expect(Object.getPrototypeOf(shaped.rows[0])).toBe(Object.prototype);
    expect(shaped.rows[1].__proto__).toBe(null);
  });

  test.each([
    ["text that is not JSON", '{"a":1}\nnot json\n'],
    ["a cut line", '{"a":1}\n{"a":'],
    ["an array", "[1,2]\n"],
    ["a number", "1\n"],
    ["null", "null\n"],
    ["a string", '"row"\n'],
  ])("%s is a not-json shape error, with no server text", (_, text) => {
    const error = shapeError(text);
    expect(error.fault).toBe("not-json");
    expect(error.serverText).toBeUndefined();
  });
});

describe("shapeJsonlBody, a column named twice", () => {
  // Measured on 3.12 Core: `SELECT c1.usage, c2.usage FROM cpu c1 CROSS JOIN cpu c2` answers the line below, and
  // `SELECT *` over the same join repeats every key. JSON.parse keeps the last value and a line omits the key of a
  // null cell, so which value belongs to which column cannot be recovered: the result is refused, never thinned.
  test.each([
    ["two projected columns of one name", '{"usage":1.5,"usage":1.5}\n', "usage"],
    [
      "SELECT * over a self join",
      '{"host":"a","idle":2.5,"time":"2026-10-07T08:48:02.650956539","usage":1.5,"host":"a","idle":2.5,"time":"2026-10-07T08:48:02.650956539","usage":1.5}\n',
      "host",
    ],
    ["a repeat on a later line", '{"a":1}\n{"b":2,"a":1,"b":3}\n', "b"],
    // Measured: a three-way self join names the key three times.
    ["three columns of one name", '{"host":"a","host":"a","host":"a"}\n', "host"],
  ])("%s is a repeated-column shape error naming the column", (_, text, column) => {
    const error = shapeError(text);
    expect(error.fault).toBe("repeated-column");
    expect(error.serverText).toBe(column);
  });

  test("a key repeated only inside a nested object is a cell, not a column", () => {
    expect(shapeJsonlBody('{"a":{"x":1,"x":2},"b":[{"x":1},{"x":2}]}\n', LIMITS).fields).toEqual(["a", "b"]);
  });
});

describe("shapeJsonlBody, the row cut and the cell budget", () => {
  const lines = (count: number, row: (index: number) => string) =>
    Array.from({ length: count }, (_, index) => row(index)).join("\n");

  test("the row cut keeps the first rows and sets cut", () => {
    const shaped = shapeJsonlBody(
      lines(5, (index) => `{"i":${index}}`),
      { rowCut: 3, cellBudget: 1000 },
    );
    expect(shaped.rows).toEqual([{ i: 0 }, { i: 1 }, { i: 2 }]);
    expect(shaped.cut).toBe(true);
  });

  test("exactly the row cut is not cut", () => {
    expect(
      shapeJsonlBody(
        lines(3, (index) => `{"i":${index}}`),
        { rowCut: 3, cellBudget: 1000 },
      ).cut,
    ).toBe(false);
  });

  test("the cell budget counts rows times columns, and a dropped row adds no column", () => {
    // Two columns: three rows are six cells. The fourth row would make four rows of three columns.
    const text = lines(3, (index) => `{"a":${index},"b":${index}}`) + '\n{"a":9,"c":9}\n{"a":10,"b":10}';
    const shaped = shapeJsonlBody(text, { rowCut: 100, cellBudget: 8 });
    expect(shaped.fields).toEqual(["a", "b"]);
    expect(shaped.rows).toHaveLength(3);
    expect(shaped.cut).toBe(true);
  });

  test("a result exactly at the cell budget is not cut", () => {
    const shaped = shapeJsonlBody(
      lines(4, (index) => `{"a":${index},"b":${index}}`),
      { rowCut: 100, cellBudget: 8 },
    );
    expect(shaped.rows).toHaveLength(4);
    expect(shaped.cut).toBe(false);
  });

  test("the shipped bounds: 10,000 rows, and 250,000 cells cut a 201-column table at 1,243 rows", () => {
    expect(
      shapeJsonlBody(
        lines(10_001, (index) => `{"i":${index}}`),
        LIMITS,
      ).rows,
    ).toHaveLength(10_000);
    const wide = `{${Array.from({ length: 201 }, (_, column) => `"c${column}":1`).join(",")}}`;
    const shaped = shapeJsonlBody(
      lines(1300, () => wide),
      LIMITS,
    );
    expect(shaped.rows).toHaveLength(1243);
    expect(shaped.cut).toBe(true);
  });
});

describe("shapeJsonlBody over hostile text (R40)", () => {
  const MIB = 1024 * 1024;

  test("a 4 MiB line that is not JSON fails fast as not-json", () => {
    const started = performance.now();
    expect(shapeError(`{"a":"${"Query would scan ".repeat((4 * MIB) / 17)}`).fault).toBe("not-json");
    expect(performance.now() - started).toBeLessThan(5000);
  });

  test("a 4 MiB key and a 4 MiB value of quotes and braces shape in one pass", () => {
    const key = '\\"{['.repeat(MIB);
    const started = performance.now();
    const shaped = shapeJsonlBody(`{"${key}":"${'}],\\"'.repeat(MIB)}"}\n`, LIMITS);
    expect(shaped.fields).toEqual([JSON.parse(`"${key}"`)]);
    expect(performance.now() - started).toBeLessThan(5000);
  });

  // R46: 3.12.0 sends `{}` for a row whose cells are all null and `{"a":1}` for a one-column row, so a 32 MiB answer
  // of short lines is ordinary; splitting it whole held 160 MiB of heap for rows the cut throws away.
  test.each([
    ["{}", {}],
    ['{"a":1}', { a: 1 }],
  ])("R46: a 32 MiB body of %s lines shapes to the row cut", (line, row) => {
    const body = `${line}\n`.repeat(Math.floor((32 * MIB) / (line.length + 1)));
    const shaped = shapeJsonlBody(body, LIMITS);
    expect(shaped.rows).toHaveLength(INFLUX_ROW_CUT);
    expect(shaped.rows[0]).toEqual(row);
    expect(shaped.cut).toBe(true);
  });

  test("R46: the body is walked line by line, never split whole", () => {
    const body = '{"a":1}\n'.repeat(100_000);
    const split = spyOn(String.prototype, "split");
    try {
      expect(shapeJsonlBody(body, LIMITS).cut).toBe(true);
      const splitLengths = split.mock.contexts.map((context) => String(context).length);
      expect(splitLengths.filter((length) => length >= body.length)).toEqual([]);
    } finally {
      split.mockRestore();
    }
  });

  test("R46: at most rowCut + 1 lines are read, so a later line that is not JSON is never parsed", () => {
    const body = `${'{"a":1}\n'.repeat(3)}not json\n`;
    const shaped = shapeJsonlBody(body, { rowCut: 2, cellBudget: 1000 });
    expect(shaped.rows).toEqual([{ a: 1 }, { a: 1 }]);
    expect(shaped.cut).toBe(true);
  });

  // R47: a line nested deeper than 64 levels is refused, so no later JSON.stringify of a row overflows the stack.
  const nested = (levels: number) => `{"a":${"[".repeat(levels - 1)}${"]".repeat(levels - 1)}}\n`;
  const nestedObjects = (levels: number) => `${'{"a":'.repeat(levels - 1)}{}${"}".repeat(levels - 1)}\n`;

  test("R47: a line nested 64 levels deep is a row", () => {
    expect(shapeJsonlBody(nested(64), LIMITS).rows).toHaveLength(1);
    expect(shapeJsonlBody(nestedObjects(64), LIMITS).fields).toEqual(["a"]);
  });

  test.each([
    ["arrays 65 levels deep", nested(65)],
    ["objects 65 levels deep", nestedObjects(65)],
    ["arrays a million levels deep", nested(1_000_000)],
  ])("R47: a line of %s is a not-json shape error", (_, text) => {
    expect(shapeError(`{"ok":1}\n${text}`).fault).toBe("not-json");
  });
});
