/**
 * CSV and TSV rows of the S3 preview: RFC 4180 quoting with the exact rules of the
 * spec, the delimiter sniff over complete records, the header always first, ragged records, and the bounds that keep
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
const heapUsed = (): number => {
  Bun.gc(true);
  return process.memoryUsage().heapUsed;
};

describe("splitCsv: the RFC 4180 rules", () => {
  test("1. a record ends at LF or CRLF outside quotes; quoted LF and CRLF are data", () => {
    expect(split('a,"x\ny"\r\n"p\r\nq",z\n').records).toEqual([
      ["a", "x\ny"],
      ["p\r\nq", "z"],
    ]);
  });

  test("1. a lone CR is data", () => {
    expect(split("a\rb,c\n").records).toEqual([["a\rb", "c"]]);
  });

  test('2. "" inside a quoted field is one quote, and a delimiter inside quotes is data', () => {
    expect(split('"a""b,c",d').records).toEqual([['a"b,c', "d"]]);
  });

  test("3. characters after a closing quote are appended to the field and counted once per field", () => {
    const result = split('"ab"cd,"x"y,z\n');
    expect(result.records).toEqual([["abcd", "xy", "z"]]);
    expect(result.quoteTrailers).toBe(2);
  });

  test("4. a quote inside an unquoted field is data", () => {
    expect(split('a"b,c').records).toEqual([['a"b', "c"]]);
  });

  test("5. a cut last record is dropped; a read ending inside a quoted field drops that record", () => {
    expect(split("a,b\n1,2\n3,", false)).toEqual({
      records: [
        ["a", "b"],
        ["1", "2"],
      ],
      quoteTrailers: 0,
      cutLast: true,
      unclosed: false,
    });
    expect(split('a\n"x\ny', false)).toEqual({ records: [["a"]], quoteTrailers: 0, cutLast: true, unclosed: false });
  });

  test("5. an unclosed quote in a whole object keeps the record as read", () => {
    expect(split('a\n"x\ny', true)).toEqual({
      records: [["a"], ["x\ny"]],
      quoteTrailers: 0,
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

  test("a final record end adds no record; a trailing delimiter is an empty last field; maxRecords stops early", () => {
    expect(split("a,b\n").records).toEqual([["a", "b"]]);
    expect(split("a,").records).toEqual([["a", ""]]);
    expect(splitCsv("a\nb\nc\n", ",", true, 2).records).toEqual([["a"], ["b"]]);
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

  test("rows stop at maxRows with N-ROWS", () => {
    expect(rows("a\n1\n2\n3\n", { maxRows: 2 })).toMatchObject({
      kind: "rows",
      rows: { rows: [["1"], ["2"]] },
      notices: ["The preview stops at 2 rows."],
    });
  });

  test('a 1,000,000-byte input of only , and one of only " each return within one second and under 64 MiB of heap', () => {
    for (const text of [",".repeat(1_000_000), '"'.repeat(1_000_000)]) {
      const before = heapUsed();
      const started = performance.now();
      rows(text);
      expect(performance.now() - started).toBeLessThan(1_000);
      expect(heapUsed() - before).toBeLessThan(64 * 1_048_576);
    }
  });
});
