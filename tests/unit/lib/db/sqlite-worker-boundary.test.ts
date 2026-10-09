import { describe, test, expect } from "bun:test";
import { deserializeCell, serializeBind, serializeCell } from "@/lib/db/providers/sql/sqlite-worker";

/**
 * The worker boundary's round-trip: `serializeCell` tags every value the child cannot
 * JSON-encode, `deserializeCell` resolves those tags back to the in-process driver's
 * shapes. These tests pin the two halves as inverses, so a drift in either side turns
 * red without a worker process (the worker itself is exercised by the provider suite).
 */

describe("sqlite worker boundary serialization", () => {
  test("a decimal 64-bit parameter is converted back to a BigInt tag before the wire", () => {
    expect(serializeBind("9007199254740993")).toEqual({ __libredb_sqlite_bigint: "9007199254740993" });
    expect(serializeBind("plain text")).toBe("plain text");
  });

  test("a small 64-bit integer round-trips as a lossless number", () => {
    expect(deserializeCell(serializeCell(BigInt(1)))).toBe(1);
    expect(deserializeCell(serializeCell(BigInt(-12)))).toBe(-12);
  });

  test("a 64-bit integer past 2^53 round-trips as its decimal digits", () => {
    expect(deserializeCell(serializeCell(BigInt("9007199254740993")))).toBe("9007199254740993");
    expect(deserializeCell(serializeCell(BigInt("9223372036854775807")))).toBe("9223372036854775807");
  });

  test("a BLOB round-trips byte-for-byte as a Buffer", () => {
    const bytes = Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff]);
    const out = deserializeCell(serializeCell(bytes));
    expect(Buffer.isBuffer(out)).toBe(true);
    expect([...(out as Buffer)]).toEqual([...bytes]);
  });

  test("an empty BLOB round-trips as an empty Buffer", () => {
    const out = deserializeCell(serializeCell(new Uint8Array(0)));
    expect(Buffer.isBuffer(out)).toBe(true);
    expect((out as Buffer).length).toBe(0);
  });

  test("null, strings, numbers and booleans pass through unchanged", () => {
    expect(deserializeCell(serializeCell(null))).toBe(null);
    expect(deserializeCell(serializeCell("雪🚀"))).toBe("雪🚀");
    expect(deserializeCell(serializeCell(42.5))).toBe(42.5);
    expect(deserializeCell(serializeCell(true))).toBe(true);
  });

  test("nested arrays and records keep their shape and their tagged cells", () => {
    const value = { a: [1, BigInt(2)], b: { blob: Uint8Array.from([1, 2, 3]) } };
    const out = deserializeCell(serializeCell(value)) as typeof value;
    expect(out.a[0]).toBe(1);
    expect(out.a[1]).toBe(2);
    expect([...(out.b.blob as Buffer)]).toEqual([1, 2, 3]);
  });

  test("a record that only LOOKS tagged is not reinterpreted", () => {
    // Two keys defeat the single-key tag shape, so the record stays a record.
    expect(deserializeCell({ __libredb_sqlite_bigint: "1", extra: true })).toEqual({
      __libredb_sqlite_bigint: "1",
      extra: true,
    });
    expect(deserializeCell({ __libredb_sqlite_bytes: [1], extra: true })).toEqual({
      __libredb_sqlite_bytes: [1],
      extra: true,
    });
  });

  test("the resolver is a strict inverse: serialize then deserialize leaves no tag behind", () => {
    const value = { big: BigInt("9007199254740993"), blob: Uint8Array.from([0, 255]) };
    const out = deserializeCell(serializeCell(value)) as { big: string; blob: Buffer };
    expect(out.big).toBe("9007199254740993");
    expect([...(out.blob as Buffer)]).toEqual([0, 255]);
  });
});
