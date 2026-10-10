/**
 * JSON and NDJSON rows of the S3 preview: members become columns, any other
 * value goes to `value` named apart from a real member, integers past 2^53 keep their digits, a cut last line is
 * dropped, and the column bound holds before any cell is rendered.
 */
import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { S3_PREVIEW_LIMITS } from "@/lib/db/providers/objectstore/s3/constants";
import { jsonDocumentRows, ndjsonRows } from "@/lib/db/providers/objectstore/s3/preview-json";
import type { RowsInput } from "@/lib/db/providers/objectstore/s3/preview-csv";

const input = (text: string, changes: Partial<RowsInput> = {}): RowsInput => ({
  text,
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
/** A JSON object of the most short, distinct members that fit in about 1,000,000 bytes. */
const wideObject = (): string => {
  const members: string[] = [];
  let length = 2;
  for (let index = 0; length < 999_980; index += 1) {
    const member = `"${index.toString(36)}":0`;
    members.push(member);
    length += member.length + 1;
  }
  return `{${members.join(",")}}`;
};
/** A JSON object of `count` members `m<from>` onwards, each holding its own number. */
const membersObject = (count: number, from = 0): string =>
  `{${Array.from({ length: count }, (_, index) => `"m${from + index}":${from + index}`).join(",")}}`;

describe("ndjsonRows", () => {
  test("a partial last line is dropped with N-LINE-CUT only when the read was cut", () => {
    expect(ndjsonRows(input('{"a":1}\n{"a":2}\n{"a":', { ended: false, readBytes: 22 }))).toEqual({
      kind: "rows",
      rows: { columns: [{ name: "a", type: "number" }], rows: [[1], [2]] },
      notices: ["The last line was cut by the 22-byte read and is not shown."],
    });
    expect(ndjsonRows(input('{"a":1}\n{"a":2}\n{"a":'))).toEqual({
      kind: "rows",
      rows: {
        columns: [
          { name: "a", type: "number" },
          { name: "value", type: "string" },
        ],
        rows: [
          [1, null],
          [2, null],
          [null, '{"a":'],
        ],
      },
      notices: ["1 line(s) are not JSON and are shown as text in column value."],
    });
  });

  test("a cut read of blank lines that ends on a line feed dropped no line, so it has no cut notice", () => {
    expect(ndjsonRows(input("\n\n", { ended: false, readBytes: 2 }))).toEqual({ kind: "text", notices: [] });
    expect(ndjsonRows(input("\n\n  ", { ended: false, readBytes: 4 }))).toEqual({
      kind: "text",
      notices: ["The last line was cut by the 4-byte read and is not shown."],
    });
  });

  test("CRLF lines, blank lines skipped and a leading byte order mark removed", () => {
    expect(ndjsonRows(input('\uFEFF{"a":1}\r\n\r\n  \n{"a":2}\r\n'))).toEqual({
      kind: "rows",
      rows: { columns: [{ name: "a", type: "number" }], rows: [[1], [2]] },
      notices: [],
    });
  });

  test("non-object and invalid lines go to value", () => {
    expect(ndjsonRows(input('{"a":1}\n5\nnot json\n'))).toEqual({
      kind: "rows",
      rows: {
        columns: [
          { name: "a", type: "number" },
          { name: "value", type: "json" },
        ],
        rows: [
          [1, null],
          [null, 5],
          [null, "not json"],
        ],
      },
      notices: ["1 line(s) are not JSON and are shown as text in column value."],
    });
  });

  test("a member named value and the added column become value and value (2), and --columns selects the second", () => {
    expect(ndjsonRows(input('{"value":1}\n2\n'))).toMatchObject({
      kind: "rows",
      rows: {
        columns: [{ name: "value" }, { name: "value (2)" }],
        rows: [
          [1, null],
          [null, 2],
        ],
      },
    });
    expect(ndjsonRows(input('{"value":1}\n2\n', { request: { columns: ["value (2)"] } }))).toMatchObject({
      kind: "rows",
      rows: { columns: [{ name: "value (2)" }], rows: [[null], [2]] },
    });
  });

  test("an integer of 2^53 + 1 keeps its digits", () => {
    expect(ndjsonRows(input('{"n":9007199254740993}\n'))).toMatchObject({
      kind: "rows",
      rows: { columns: [{ name: "n", type: "string" }], rows: [["9007199254740993"]] },
    });
  });

  test("a line longer than the whole read gives text rows with N-LINE-CUT, never an empty grid", () => {
    expect(ndjsonRows(input('{"a":1', { ended: false, readBytes: 6 }))).toEqual({
      kind: "text",
      notices: ["The last line was cut by the 6-byte read and is not shown."],
    });
  });

  test("a cut read holding only blank lines before its partial line answers text rows", () => {
    expect(ndjsonRows(input('\n\n{"a"', { ended: false, readBytes: 6 }))).toEqual({
      kind: "text",
      notices: ["The last line was cut by the 6-byte read and is not shown."],
    });
  });

  test("a whole object of only blank lines answers text rows with no cut notice", () => {
    expect(ndjsonRows(input("\n \r\n"))).toEqual({ kind: "text", notices: [] });
  });

  test("rows stop at maxRows", () => {
    expect(ndjsonRows(input("1\n2\n3\n", { maxRows: 2 }))).toMatchObject({
      rows: { rows: [[1], [2]] },
      notices: ["The preview stops at 2 rows."],
    });
  });

  test("the member names of all lines are counted past the 8,192 kept names, and value stays selectable", () => {
    const text = `${membersObject(5_000)}\n${membersObject(5_000, 5_000)}\n7\n`;
    const result = ndjsonRows(input(text));
    expect(result.kind === "rows" && result.rows.columns).toHaveLength(1_024);
    expect(result.notices).toEqual(["Showing the first 1,024 of 10,001 columns."]);
    expect(ndjsonRows(input(text, { request: { columns: ["m8191", "value"] } }))).toMatchObject({
      rows: {
        columns: [{ name: "m8191" }, { name: "value" }],
        rows: [
          [null, null],
          [8191, null],
          [null, 7],
        ],
      },
    });
    expect(() => ndjsonRows(input(text, { request: { columns: ["m8192"] } }))).toThrow(
      new QueryError("The preview has no column m8192.", "s3"),
    );
  });

  test("a 1,000,000-byte line holding a wide object builds its rows within one second and under 64 MiB of heap", () => {
    const text = `${wideObject()}\n`;
    const before = heapUsed();
    const started = performance.now();
    const result = ndjsonRows(input(text));
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(heapUsed() - before).toBeLessThan(64 * 1_048_576);
    expect(result.kind === "rows" && result.rows.columns).toHaveLength(1_024);
  });
});

describe("jsonDocumentRows", () => {
  test("an array of objects", () => {
    expect(jsonDocumentRows(input('[{"a":1},{"b":2}]'))).toEqual({
      kind: "rows",
      rows: {
        columns: [
          { name: "a", type: "number" },
          { name: "b", type: "number" },
        ],
        rows: [
          [1, null],
          [null, 2],
        ],
      },
      notices: [],
    });
  });

  test("an array of scalars, and a mixed array", () => {
    expect(jsonDocumentRows(input('[1,"x",null]'))).toMatchObject({
      rows: { columns: [{ name: "value", type: "json" }], rows: [[1], ["x"], [null]] },
    });
    expect(jsonDocumentRows(input('[{"a":1},2]'))).toMatchObject({
      rows: {
        columns: [{ name: "a" }, { name: "value" }],
        rows: [
          [1, null],
          [null, 2],
        ],
      },
    });
  });

  test("an object is one row of its members; a scalar is one row of value", () => {
    expect(jsonDocumentRows(input('{"a":1,"b":[1,2]}'))).toMatchObject({
      rows: {
        columns: [
          { name: "a", type: "number" },
          { name: "b", type: "array" },
        ],
        rows: [[1, "[1,2]"]],
      },
    });
    expect(jsonDocumentRows(input('"s"'))).toMatchObject({
      rows: { columns: [{ name: "value", type: "string" }], rows: [["s"]] },
    });
  });

  test("a repeated member keeps the last value, as JSON.parse does", () => {
    expect(jsonDocumentRows(input('{"a":1,"a":2}'))).toMatchObject({ rows: { rows: [[2]] } });
  });

  test("an object of 2,000 members gives maxColumns columns and N-COLUMNS; an unknown --columns name is refused", () => {
    const members = Array.from({ length: 2_000 }, (_, index) => `"m${index}":${index}`).join(",");
    expect(jsonDocumentRows(input(`{${members}}`, { limits: { ...S3_PREVIEW_LIMITS, maxColumns: 10 } }))).toMatchObject(
      {
        notices: ["Showing the first 10 of 2,000 columns."],
      },
    );
    expect(() => jsonDocumentRows(input('{"a":1}', { request: { columns: ["b"] } }))).toThrow(
      new QueryError("The preview has no column b.", "s3"),
    );
  });

  test("an object of 10,000 members names only the first 8,192 and N-COLUMNS reports the true count", () => {
    const text = membersObject(10_000);
    expect(jsonDocumentRows(input(text)).notices).toEqual(["Showing the first 1,024 of 10,000 columns."]);
    expect(jsonDocumentRows(input(text, { request: { columns: ["m8191"] } }))).toMatchObject({
      rows: { columns: [{ name: "m8191" }], rows: [[8191]] },
      notices: [],
    });
    expect(() => jsonDocumentRows(input(text, { request: { columns: ["m8192"] } }))).toThrow(
      new QueryError("The preview has no column m8192.", "s3"),
    );
  });

  test("an array longer than maxRows stops with N-ROWS", () => {
    expect(jsonDocumentRows(input("[1,2,3]", { maxRows: 2 }))).toMatchObject({
      rows: { rows: [[1], [2]] },
      notices: ["The preview stops at 2 rows."],
    });
  });

  test("a 1,000,000-byte object of short members builds its row within one second and under 64 MiB of heap", () => {
    const text = wideObject();
    const before = heapUsed();
    const started = performance.now();
    jsonDocumentRows(input(text));
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(heapUsed() - before).toBeLessThan(64 * 1_048_576);
  });
});
