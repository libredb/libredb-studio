import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import type { KafkaRecord } from "@/lib/db/providers/stream/kafka/client";
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

  test("an offset past 2^53 keeps every digit", () => {
    const { row } = shapeRecord(record({ offset: BigInt("9007199254740993") }), { cellLimit: 1000 });
    expect(row.offset).toBe("9007199254740993");
  });

  test("the protocol's no-timestamp value (-1) is null, never a 1969 instant", () => {
    const { row } = shapeRecord(record({ timestamp: BigInt(-1) }), { cellLimit: 1000 });
    expect(row.timestamp).toBeNull();
    // Control: the millisecond before the epoch is still an instant when it is not the sentinel.
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
    expect(shapeRecord(record({ headers: [[null, enc("v")]] }), { cellLimit: 10 }).row.headers).toEqual({ null: "v" });
  });

  test("truncated cells are counted, header names and values included", () => {
    const shaped = shapeRecord(
      record({ value: enc("z".repeat(40)), headers: [[enc("n".repeat(20)), enc("w".repeat(20))]] }),
      {
        cellLimit: 10,
      },
    );
    expect(shaped.truncatedCells).toBe(3);
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
