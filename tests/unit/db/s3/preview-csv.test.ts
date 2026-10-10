/**
 * CSV and TSV rows of the S3 preview: RFC 4180 quoting, the delimiter sniff over complete records, the header always first, ragged records, and the bounds that keep
 * a hostile 1,000,000-byte read linear.
 */
import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { S3_PREVIEW_LIMITS } from "@/lib/db/providers/objectstore/s3/constants";
import { csvRows, sniffDelimiter, splitCsv } from "@/lib/db/providers/objectstore/s3/preview-csv";

const split = (text: string, ended = true) => splitCsv(text, ",", ended);
const rows = (text: string, changes: Partial<Parameters<typeof csvRows>[0]> = {}) =>
  csvRows({
    text,
    format: "csv",
    ended: true,
    readBytes: 1_000_000,
    request: {},
    maxRows: 100,
    limits: S3_PREVIEW_LIMITS,
    ...changes,
  });
// A heap read without a full collection first counts garbage not yet collected, so every read collects.
const heapUsed = (): number => {
  Bun.gc(true);
  return process.memoryUsage().heapUsed;
};

describe("splitCsv: RFC 4180 quoting", () => {
  test("a record ends at LF or CRLF outside quotes; quoted LF and CRLF are data", () => {
    expect(split('a,"x\ny"\r\n"p\r\nq",z\n').records).toEqual([
      ["a", "x\ny"],
      ["p\r\nq", "z"],
    ]);
  });

  test("a lone CR is data", () => {
    expect(split("a\rb,c\n").records).toEqual([["a\rb", "c"]]);
  });

  test('"" inside a quoted field is one quote, and a delimiter inside quotes is data', () => {
    expect(split('"a""b,c",d').records).toEqual([['a"b,c', "d"]]);
  });

  test("characters after a closing quote are appended to the field and counted once per field, by its position", () => {
    const result = split('"ab"cd,"x"y,z\n');
    expect(result.records).toEqual([["abcd", "xy", "z"]]);
    expect(result.quoteTrailerFields).toEqual([0, 1]);
  });

  test("a quote inside an unquoted field is data", () => {
    expect(split('a"b,c').records).toEqual([['a"b', "c"]]);
  });

  test("a cut last record is dropped; a read ending inside a quoted field drops that record", () => {
    expect(split("a,b\n1,2\n3,", false)).toEqual({
      records: [
        ["a", "b"],
        ["1", "2"],
      ],
      fieldCounts: [2, 2],
      quoteTrailerFields: [],
      cutLast: true,
      unclosed: false,
    });
    expect(split('a\n"x\ny', false)).toEqual({
      records: [["a"]],
      fieldCounts: [1],
      quoteTrailerFields: [],
      cutLast: true,
      unclosed: false,
    });
  });

  test("an unclosed quote in a whole object keeps the record as read", () => {
    expect(split('a\n"x\ny', true)).toEqual({
      records: [["a"], ["x\ny"]],
      fieldCounts: [1, 1],
      quoteTrailerFields: [],
      cutLast: false,
      unclosed: true,
    });
  });

  test("a read cut between the CR and the LF drops the record; a whole object keeps the CR as data", () => {
    expect(split("a,b\r\n1,2\r", false).records).toEqual([["a", "b"]]);
    expect(split("a,b\r\n1,2\r", false).cutLast).toBe(true);
    expect(split("a,b\r\n1,2\r", true).records).toEqual([
      ["a", "b"],
      ["1", "2\r"],
    ]);
  });

  test("trailing characters count only in kept records: not in a cut last record, not past keptRecords", () => {
    expect(split('h\n1\n"x"y', false)).toEqual({
      records: [["h"], ["1"]],
      fieldCounts: [1, 1],
      quoteTrailerFields: [],
      cutLast: true,
      unclosed: false,
    });
    expect(splitCsv('"a"b\n"c"d\n"e"f\n', ",", true, 3, 2)).toEqual({
      records: [["ab"], ["cd"], ["ef"]],
      fieldCounts: [1, 1, 1],
      quoteTrailerFields: [0, 0],
      cutLast: false,
      unclosed: false,
    });
  });

  test("a final record end adds no record; a trailing delimiter is an empty last field; maxRecords stops early", () => {
    expect(split("a,b\n").records).toEqual([["a", "b"]]);
    expect(split("a,").records).toEqual([["a", ""]]);
    expect(splitCsv("a\nb\nc\n", ",", true, 2).records).toEqual([["a"], ["b"]]);
  });
});

describe("splitCsv: the field bound", () => {
  test("fields past maxFields are counted but not stored, and their trailing characters are not counted", () => {
    expect(splitCsv('a,b,c,"d"x\n1,2\n', ",", true, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, 2)).toEqual({
      records: [
        ["a", "b"],
        ["1", "2"],
      ],
      fieldCounts: [4, 2],
      quoteTrailerFields: [],
      cutLast: false,
      unclosed: false,
    });
  });

  test("a whole object's last record without a record end is bounded the same way", () => {
    const result = splitCsv("a,b,c", ",", true, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, 1);
    expect(result.records).toEqual([["a"]]);
    expect(result.fieldCounts).toEqual([3]);
  });
});

describe("sniffDelimiter", () => {
  test("a semicolon file picks ;", () => {
    expect(sniffDelimiter("a;b;c\n1;2;3\n", true, 20)).toBe(";");
  });

  test("a tie goes to the first candidate in the order , ; tab |", () => {
    expect(sniffDelimiter("a,b;c\n1,2;3\n", true, 20)).toBe(",");
  });

  test("a candidate with a ragged field count does not score", () => {
    expect(sniffDelimiter("a|b,c\n1|2\n", true, 20)).toBe("|");
  });

  test("no complete record, or no candidate above one field, gives ,", () => {
    expect(sniffDelimiter("a;b;c", false, 20)).toBe(",");
    expect(sniffDelimiter("a\nb\n", true, 20)).toBe(",");
  });

  test("the sniff compares true field counts, not the kept fields", () => {
    expect(sniffDelimiter("a,b;c\n1,2;3,4\n", true, 20, 2)).toBe(";");
  });

  test("a single complete record scores a candidate that splits it", () => {
    expect(sniffDelimiter("a;b;c", true, 20)).toBe(";");
  });
});

describe("csvRows", () => {
  test("a header and two records; a byte order mark is removed; every column is text", () => {
    expect(rows("\uFEFFid,name\n1,a\n2,b\n")).toEqual({
      kind: "rows",
      rows: {
        columns: [
          { name: "id", type: "text" },
          { name: "name", type: "text" },
        ],
        rows: [
          ["1", "a"],
          ["2", "b"],
        ],
      },
      notices: [],
    });
  });

  test("ragged records: missing fields are null and extra fields go to columns named by position", () => {
    const result = rows("a,b\n1\n1,2,3\n");
    expect(result).toEqual({
      kind: "rows",
      rows: {
        columns: [
          { name: "a", type: "text" },
          { name: "b", type: "text" },
          { name: "column 3", type: "text" },
        ],
        rows: [
          ["1", null, null],
          ["1", "2", "3"],
        ],
      },
      notices: [
        "2 record(s) have a different number of fields from the header: missing fields are empty and extra fields are shown in columns named by position.",
      ],
    });
  });

  test("an empty header name and a repeated one are named apart", () => {
    const result = rows(",a,a\n1,2,3\n");
    expect(result.kind === "rows" && result.rows.columns.map((column) => column.name)).toEqual([
      "(No column name)",
      "a",
      "a (2)",
    ]);
  });

  test("a header of 2,000 fields gives maxColumns columns and N-COLUMNS", () => {
    const header = Array.from({ length: 2_000 }, (_, index) => `c${index}`).join(",");
    const result = rows(`${header}\n`, { limits: { ...S3_PREVIEW_LIMITS, maxColumns: 10 } });
    expect(result.kind === "rows" && result.rows.columns).toHaveLength(10);
    expect(result.notices).toEqual(["Showing the first 10 of 2,000 columns."]);
  });

  test("a header of 10,000 fields keeps 8,192 fields per record and N-COLUMNS reports the true count", () => {
    const header = Array.from({ length: 10_000 }, (_, index) => `c${index}`).join(",");
    const result = rows(`${header}\n`);
    expect(result.kind === "rows" && result.rows.columns).toHaveLength(1_024);
    expect(result.notices).toEqual(["Showing the first 1,024 of 10,000 columns."]);
  });

  test("a column past the 8,192 kept fields is refused by name; one inside them is shown", () => {
    const header = Array.from({ length: 9_000 }, (_, index) => `c${index}`).join(",");
    const record = Array.from({ length: 9_000 }, (_, index) => `${index}`).join(",");
    expect(rows(`${header}\n${record}\n`, { request: { columns: ["c8191"] } })).toMatchObject({
      kind: "rows",
      rows: { columns: [{ name: "c8191" }], rows: [["8191"]] },
      notices: [],
    });
    expect(() => rows(`${header}\n${record}\n`, { request: { columns: ["c8192"] } })).toThrow(
      new QueryError("The preview has no column c8192.", "s3"),
    );
  });

  test("a record wider than the kept fields is ragged by its true count, and extra columns stop at the bound", () => {
    const record = Array.from({ length: 9_000 }, () => "x").join(",");
    const result = rows(`a,b\n${record}\n`);
    expect(result.kind === "rows" && result.rows.columns).toHaveLength(1_024);
    expect(result.notices).toEqual([
      "1 record(s) have a different number of fields from the header: missing fields are empty and extra fields are shown in columns named by position.",
      "Showing the first 1,024 of 9,000 columns.",
    ]);
  });

  test("--columns reorders, addresses a renamed column, and refuses an unknown name", () => {
    expect(rows("a,b\n1,2\n", { request: { columns: ["b", "a"] } })).toMatchObject({
      kind: "rows",
      rows: { rows: [["2", "1"]] },
    });
    expect(rows("name,name\n1,2\n", { request: { columns: ["name (2)"] } })).toMatchObject({
      kind: "rows",
      rows: { columns: [{ name: "name (2)", type: "text" }], rows: [["2"]] },
    });
    expect(() => rows("a\n1\n", { request: { columns: ["zz"] } })).toThrow(
      new QueryError("The preview has no column zz.", "s3"),
    );
  });

  test("a header-only CSV gives its columns and no rows, with ; sniffed", () => {
    expect(rows("a;b;c")).toEqual({
      kind: "rows",
      rows: {
        columns: [
          { name: "a", type: "text" },
          { name: "b", type: "text" },
          { name: "c", type: "text" },
        ],
        rows: [],
      },
      notices: [],
    });
  });

  test("a first record longer than the read has no header: text rows with N-RECORD-CUT", () => {
    expect(rows("a".repeat(16), { ended: false, readBytes: 16 })).toEqual({
      kind: "text",
      notices: ["The last record was cut by the 16-byte read and is not shown."],
    });
  });

  test("a field with trailing characters in a record that is not shown is not counted", () => {
    expect(rows('h\n1\n"x"y', { ended: false, readBytes: 8 }).notices).toEqual([
      "The last record was cut by the 8-byte read and is not shown.",
    ]);
    expect(rows('h\n1\n"x"y\n', { maxRows: 1 }).notices).toEqual(["The preview stops at 1 rows."]);
  });

  test("a whole object holding only a byte order mark is text with no cut notice", () => {
    expect(rows("\uFEFF", { ended: true })).toEqual({ kind: "text", notices: [] });
  });

  test("TSV never sniffs: a comma stays inside its field", () => {
    expect(rows("a,b\tc\n1,2\t3\n", { format: "tsv" })).toMatchObject({
      kind: "rows",
      rows: { columns: [{ name: "a,b" }, { name: "c" }], rows: [["1,2", "3"]] },
    });
  });

  test("notices in order: trailing characters, the cut record, then the row notices", () => {
    expect(rows('"a"x,b\n1,2\n3', { ended: false, readBytes: 13 }).notices).toEqual([
      "1 field(s) have characters after their closing quote; they are shown as read.",
      "The last record was cut by the 13-byte read and is not shown.",
    ]);
    expect(rows('a\n"x', { ended: true }).notices).toEqual([
      "The last record has a quote that is never closed; it is shown up to the end of the object.",
    ]);
  });

  test("trailing characters count only in shown columns: not past the column bound, not outside a column list", () => {
    const width = S3_PREVIEW_LIMITS.maxColumns + 1;
    const header = Array.from({ length: width }, (_, index) => `h${index}`).join(",");
    const record = [...Array.from({ length: width - 1 }, () => "1"), '"x"y'].join(",");
    expect(rows(`${header}\n${record}\n`).notices).toEqual([
      `Showing the first ${S3_PREVIEW_LIMITS.maxColumns.toLocaleString("en-US")} of ${width.toLocaleString("en-US")} columns.`,
    ]);
    expect(rows('a,b\n1,"x"y\n', { request: { columns: ["a"] } }).notices).toEqual([]);
    expect(rows('a,b\n1,"x"y\n', { request: { columns: ["b"] } }).notices).toEqual([
      "1 field(s) have characters after their closing quote; they are shown as read.",
    ]);
  });

  test("rows stop at maxRows with N-ROWS", () => {
    expect(rows("a\n1\n2\n3\n", { maxRows: 2 })).toMatchObject({
      kind: "rows",
      rows: { rows: [["1"], ["2"]] },
      notices: ["The preview stops at 2 rows."],
    });
  });

  test('a 1,000,000-byte input of only , and one of only " each return within five seconds and under 64 MiB of heap', () => {
    for (const text of [",".repeat(1_000_000), '"'.repeat(1_000_000)]) {
      const before = heapUsed();
      const started = performance.now();
      rows(text);
      // About 0.4 s on an idle machine; five seconds leaves room for a loaded CI runner.
      expect(performance.now() - started).toBeLessThan(5_000);
      expect(heapUsed() - before).toBeLessThan(64 * 1_048_576);
    }
  });
});
