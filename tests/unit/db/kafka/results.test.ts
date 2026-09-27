import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import type { KafkaRecord } from "@/lib/db/providers/stream/kafka/client";
import { KAFKA_CELL_LIMIT } from "@/lib/db/providers/stream/kafka/read";
import {
  compareRecords,
  KAFKA_RESULT_FIELDS,
  shapeRecord,
  toQueryResult,
} from "@/lib/db/providers/stream/kafka/results";

const enc = (s: string) => new TextEncoder().encode(s);
const record = (over: Partial<KafkaRecord> = {}): KafkaRecord => ({
  partition: 1,
  offset: BigInt(5),
  timestamp: BigInt(1790125251021),
  key: enc("key-0"),
  value: enc('{"id":25}'),
  headers: [],
  ...over,
});

describe("shapeRecord", () => {
  test("the fixed fields, offset as a string, timestamp as ISO-8601 UTC", () => {
    const { row } = shapeRecord(record(), { cellLimit: 1000 });
    expect(Object.keys(row)).toEqual([...KAFKA_RESULT_FIELDS]);
    expect(row).toMatchObject({
      partition: 1,
      offset: "5",
      timestamp: "2026-09-23T01:00:51.021Z",
      key: "key-0",
      key_encoding: "text",
      value: { id: 25 },
      value_encoding: "json",
    });
  });

  test("a JSON key and a JSON header value keep an integer past 2^53 exactly, as the value does", () => {
    const { row } = shapeRecord(
      record({
        key: enc('{"orderId":12345678901234567890}'),
        value: enc('{"id":9007199254740993}'),
        headers: [[enc("json-value"), enc('{"x":12345678901234567890}')]],
      }),
      { cellLimit: 1000 },
    );
    expect(row).toMatchObject({
      key: { orderId: "12345678901234567890" },
      key_encoding: "json",
      value: { id: "9007199254740993" },
      value_encoding: "json",
      headers: { "json-value": { x: "12345678901234567890" } },
    });
  });

  test("an offset past 2^53 keeps every digit", () => {
    const { row } = shapeRecord(record({ offset: BigInt("9007199254740993") }), { cellLimit: 1000 });
    expect(row.offset).toBe("9007199254740993");
  });

  test("the protocol's no-timestamp value (-1) is null, never a 1969 instant", () => {
    const { row } = shapeRecord(record({ timestamp: BigInt(-1) }), { cellLimit: 1000 });
    expect(row.timestamp).toBeNull();
    // Control: the nearest negative value that is not the sentinel is still an instant.
    expect(shapeRecord(record({ timestamp: BigInt(-2) }), { cellLimit: 1000 }).row.timestamp).toBe(
      "1969-12-31T23:59:59.998Z",
    );
    // Control: the epoch itself is an instant too.
    expect(shapeRecord(record({ timestamp: BigInt(0) }), { cellLimit: 1000 }).row.timestamp).toBe(
      "1970-01-01T00:00:00.000Z",
    );
  });

  test("a timestamp outside the Date range is a QueryError naming the partition and offset", () => {
    const beyond = () =>
      shapeRecord(record({ partition: 2, offset: BigInt(7), timestamp: BigInt("8640000000000001") }), {
        cellLimit: 1000,
      });
    expect(beyond).toThrow(QueryError);
    expect(beyond).toThrow(
      "The record at partition 2, offset 7 has timestamp 8640000000000001, which is outside the range a date can show (-8640000000000000 to 8640000000000000 ms); read from a later offset to skip it.",
    );
    const before = () => shapeRecord(record({ timestamp: BigInt("-10000000000000000") }), { cellLimit: 1000 });
    expect(before).toThrow("has timestamp -10000000000000000");
    // Controls: both ends of the range are still instants.
    expect(shapeRecord(record({ timestamp: BigInt("8640000000000000") }), { cellLimit: 1000 }).row.timestamp).toBe(
      "+275760-09-13T00:00:00.000Z",
    );
    expect(shapeRecord(record({ timestamp: BigInt("-8640000000000000") }), { cellLimit: 1000 }).row.timestamp).toBe(
      "-271821-04-20T00:00:00.000Z",
    );
  });

  test("headers: an object; a repeated name becomes an array in arrival order", () => {
    const { row } = shapeRecord(
      record({
        headers: [
          [enc("trace"), enc("t0")],
          [enc("trace"), enc("u0")],
          [enc("h1"), enc("v1")],
        ],
      }),
      { cellLimit: 1000 },
    );
    expect(row.headers).toEqual({ trace: ["t0", "u0"], h1: "v1" });
  });

  test("no headers is an empty object", () => {
    expect(shapeRecord(record(), { cellLimit: 1000 }).row.headers).toEqual({});
  });

  test("Review Focus 3: a null header value is null, a non-UTF-8 header name is base64, nothing is dropped", () => {
    const { row } = shapeRecord(
      record({
        headers: [
          [enc("h"), null],
          [new Uint8Array([0xff]), enc("x")],
        ],
      }),
      {
        cellLimit: 1000,
      },
    );
    expect(row.headers).toEqual({ h: null, "/w== (1 bytes)": "x" });
  });

  test("Review Focus 3: __proto__, toString and JSON-looking names are ordinary headers, kept apart", () => {
    const { row } = shapeRecord(
      record({
        headers: [
          [enc("__proto__"), enc("abc")],
          [enc("toString"), enc("x")],
          [enc('{"a":1}'), enc("one")],
          [enc('{"b":2}'), enc("two")],
          [enc("[1,2]"), enc("v")],
        ],
      }),
      { cellLimit: 1000 },
    );
    // Compared as JSON text: an object literal holding `__proto__:` would set a prototype, not a key.
    expect(JSON.stringify(row.headers)).toBe(
      '{"__proto__":"abc","toString":"x","{\\"a\\":1}":"one","{\\"b\\":2}":"two","[1,2]":"v"}',
    );
    expect(Object.keys(row.headers as object)).toEqual(["__proto__", "toString", '{"a":1}', '{"b":2}', "[1,2]"]);
    expect(Object.getPrototypeOf(row.headers)).toBe(Object.prototype);
  });

  test("a JSON-array header value repeated under one name stays two values", () => {
    const { row } = shapeRecord(
      record({
        headers: [
          [enc("ids"), enc("[1,2]")],
          [enc("ids"), enc("[3]")],
        ],
      }),
      { cellLimit: 1000 },
    );
    expect(row.headers).toEqual({ ids: [[1, 2], [3]] });
  });

  test("a null key is null with encoding null, and a null header name reads as the string null", () => {
    expect(shapeRecord(record({ key: null }), { cellLimit: 10 }).row).toMatchObject({
      key: null,
      key_encoding: "null",
    });
    // A limit the cell fits in, since {"null":"v"} is 12 characters.
    expect(shapeRecord(record({ headers: [[null, enc("v")]] }), { cellLimit: 100 }).row.headers).toEqual({ null: "v" });
  });

  test("truncated cells are counted per cell: the value, and the headers cell once, whatever it cut", () => {
    const shaped = shapeRecord(
      record({ value: enc("z".repeat(40)), headers: [[enc("n".repeat(20)), enc("w".repeat(20))]] }),
      {
        cellLimit: 10,
      },
    );
    expect(shaped.truncatedCells).toBe(2);
    // Control: the same record under a limit that fits every cell cuts nothing.
    expect(
      shapeRecord(record({ value: enc("z".repeat(40)), headers: [[enc("n".repeat(20)), enc("w".repeat(20))]] }), {
        cellLimit: 1000,
      }).truncatedCells,
    ).toBe(0);
  });

  test("a truncated key is counted too", () => {
    expect(shapeRecord(record({ key: enc("k".repeat(20)) }), { cellLimit: 10 }).truncatedCells).toBe(1);
  });
});

describe("the headers cell is one cell, bounded by the cell limit (spec 5.4)", () => {
  /** The text the grid renders for the headers cell. */
  const rendered = (row: Record<string, unknown>) => JSON.stringify(row.headers).length;

  test("150 header values of 60,000 bytes answer a headers cell within the limit, and the cut is counted", () => {
    const value = "x".repeat(60_000);
    const { row, truncatedCells } = shapeRecord(
      record({ headers: Array.from({ length: 150 }, (_, i) => [enc(`h${i}`), enc(value)] as const) }),
      { cellLimit: KAFKA_CELL_LIMIT },
    );
    expect(rendered(row)).toBeLessThanOrEqual(KAFKA_CELL_LIMIT);
    // The first header fits whole; the second would pass the limit, so it and every later one are left out.
    expect(row.headers).toEqual({ h0: value });
    expect(truncatedCells).toBe(1);
  });

  test("a headers cell of exactly the limit is whole, and one character past it is cut", () => {
    // {"a":"xxxxxxxxxxxx"} is 20 characters.
    const whole = shapeRecord(record({ headers: [[enc("a"), enc("x".repeat(12))]] }), { cellLimit: 20 });
    expect(whole.row.headers).toEqual({ a: "x".repeat(12) });
    expect(rendered(whole.row)).toBe(20);
    expect(whole.truncatedCells).toBe(0);
    const past = shapeRecord(record({ headers: [[enc("a"), enc("x".repeat(13))]] }), { cellLimit: 20 });
    expect(past.row.headers).toEqual({});
    expect(past.truncatedCells).toBe(1);
  });

  test("headers join in arrival order, and the first that does not fit ends the cell, though a later one would fit", () => {
    const { row, truncatedCells } = shapeRecord(
      record({
        headers: [
          [enc("a"), enc("x".repeat(5))],
          [enc("b"), enc("y".repeat(20))],
          [enc("c"), enc("z")],
        ],
      }),
      { cellLimit: 30 },
    );
    expect(row.headers).toEqual({ a: "xxxxx" });
    expect(truncatedCells).toBe(1);
  });

  test("a repeated name's brackets are counted, so its values stop where the cell does", () => {
    const repeated = [
      [enc("t"), enc("1")],
      [enc("t"), enc("2")],
      [enc("t"), enc("3")],
    ] as const;
    // {"t":["1","2","3"]} is 19 characters, {"t":["1","2"]} 15, and {"t":"1"} 9.
    expect(shapeRecord(record({ headers: repeated }), { cellLimit: 19 }).row.headers).toEqual({ t: ["1", "2", "3"] });
    const cut = shapeRecord(record({ headers: repeated }), { cellLimit: 18 });
    expect(cut.row.headers).toEqual({ t: ["1", "2"] });
    expect(cut.truncatedCells).toBe(1);
    expect(shapeRecord(record({ headers: repeated }), { cellLimit: 14 }).row.headers).toEqual({ t: "1" });
  });

  test("the size is the text the grid renders: escapes, a JSON value, a null value and the separators", () => {
    const headers = [
      [enc('q"'), enc('a"b')],
      [enc("j"), enc('{"a":1}')],
      [enc("n"), null],
    ] as const;
    // {"q\"":"a\"b","j":{"a":1},"n":null} is 35 characters.
    const whole = shapeRecord(record({ headers }), { cellLimit: 35 });
    expect(whole.row.headers).toEqual({ 'q"': 'a"b', j: { a: 1 }, n: null });
    expect(rendered(whole.row)).toBe(35);
    expect(whole.truncatedCells).toBe(0);
    const cut = shapeRecord(record({ headers }), { cellLimit: 34 });
    expect(cut.row.headers).toEqual({ 'q"': 'a"b', j: { a: 1 } });
    expect(cut.truncatedCells).toBe(1);
  });

  test("the count is per cell: a cut key, a cut value and a cut headers cell are three", () => {
    const heavy = record({
      key: enc("k".repeat(20)),
      value: enc("z".repeat(40)),
      headers: [
        [enc("n".repeat(20)), enc("w".repeat(20))],
        [enc("m"), enc("v")],
      ],
    });
    const shaped = shapeRecord(heavy, { cellLimit: 10 });
    expect(shaped.truncatedCells).toBe(3);
    expect(shaped.row.headers).toEqual({});
    // Control: a limit that fits every cell cuts nothing and keeps every header.
    const fits = shapeRecord(heavy, { cellLimit: 1000 });
    expect(fits.truncatedCells).toBe(0);
    expect(fits.row.headers).toEqual({ ["n".repeat(20)]: "w".repeat(20), m: "v" });
  });
});

describe("compareRecords", () => {
  test("orders by timestamp, then partition, then offset", () => {
    const rows = [
      record({ timestamp: BigInt(2), partition: 0, offset: BigInt(1) }),
      record({ timestamp: BigInt(1), partition: 2, offset: BigInt(9) }),
      record({ timestamp: BigInt(1), partition: 1, offset: BigInt(8) }),
      record({ timestamp: BigInt(1), partition: 1, offset: BigInt(3) }),
    ].sort(compareRecords);
    expect(rows.map((r) => `${r.timestamp}/${r.partition}/${r.offset}`)).toEqual(["1/1/3", "1/1/8", "1/2/9", "2/0/1"]);
  });

  test("within one partition whose CreateTime goes back along the log, rows follow the timestamps, not log order (spec 5.2)", () => {
    const timestamps = [50, 60, 10, 20, 30];
    const rows = timestamps
      .map((timestamp, offset) => ({ timestamp: BigInt(timestamp), partition: 0, offset: BigInt(offset) }))
      .sort(compareRecords);
    expect(rows.map((r) => String(r.offset))).toEqual(["2", "3", "4", "0", "1"]);
  });

  test("offsets past 2^53 that differ only in the last digit still order", () => {
    const a = { timestamp: BigInt(1), partition: 0, offset: BigInt("9007199254740993") };
    const b = { timestamp: BigInt(1), partition: 0, offset: BigInt("9007199254740992") };
    expect(compareRecords(a, b)).toBe(1);
    expect(compareRecords(b, a)).toBe(-1);
  });

  test("equal records compare equal", () => {
    expect(compareRecords(record(), record())).toBe(0);
  });
});

describe("toQueryResult", () => {
  test("fields, rowCount, pagination and warnings: a bound the provider applied is wasLimited, never hasMore", () => {
    const result = toQueryResult([{ a: 1 }], 12, 50, [{ message: "cut" }], true);
    expect(result).toEqual({
      rows: [{ a: 1 }],
      fields: [...KAFKA_RESULT_FIELDS],
      rowCount: 1,
      executionTime: 12,
      pagination: { limit: 50, offset: 0, hasMore: false, totalReturned: 1, wasLimited: true },
      warnings: [{ message: "cut" }],
    });
  });

  test("no warnings key when there are none", () => {
    const result = toQueryResult([], 1, 50, [], false);
    expect("warnings" in result).toBe(false);
    expect(result.pagination).toEqual({ limit: 50, offset: 0, hasMore: false, totalReturned: 0, wasLimited: false });
  });

  test("fields is a fresh array each time, so a caller cannot change the shared column list", () => {
    const first = toQueryResult([], 1, 50, [], false);
    first.fields.push("extra");
    expect(toQueryResult([], 1, 50, [], false).fields).toEqual([...KAFKA_RESULT_FIELDS]);
    expect(Object.isFrozen(KAFKA_RESULT_FIELDS)).toBe(true);
  });
});
