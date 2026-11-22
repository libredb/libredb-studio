import { describe, test, expect } from "bun:test";
import { deserializeCell, serializeBinds } from "@/lib/db/providers/sql/sqlite-worker";
import { encodeValue, ValueCodecError } from "@/lib/db/value-codec";

/**
 * The parent half of the worker boundary: `serializeBinds` writes bound parameters in
 * Studio's value codec, and `deserializeCell` decodes what the child answers and gives
 * it the in-process driver's shapes. These tests pin the parent half without a worker
 * process; the child's copy of the codec is held by round trips through the real child
 * in tests/integration/db/sqlite-worker.test.ts.
 */

describe("sqlite worker boundary serialization", () => {
  test("a decimal 64-bit parameter is converted back to an i64 before the wire", () => {
    expect(serializeBinds(["9007199254740993", "plain text"])).toEqual([
      { $: "i64", v: "9007199254740993" },
      "plain text",
    ]);
  });

  test("a parameter outside the codec's domain is refused by the parent, naming its place", () => {
    let refused: unknown;
    try {
      serializeBinds([1, undefined]);
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(ValueCodecError);
    expect((refused as ValueCodecError).path).toBe("/1");
  });

  test("a small 64-bit integer decodes as a lossless number", () => {
    expect(deserializeCell(encodeValue(BigInt(1)))).toBe(1);
    expect(deserializeCell(encodeValue(BigInt(-12)))).toBe(-12);
  });

  test("a 64-bit integer past 2^53 decodes as its decimal digits", () => {
    expect(deserializeCell(encodeValue(BigInt("9007199254740993")))).toBe("9007199254740993");
    expect(deserializeCell(encodeValue(BigInt("9223372036854775807")))).toBe("9223372036854775807");
  });

  test("a BLOB decodes byte for byte as a Buffer", () => {
    const bytes = Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff]);
    const out = deserializeCell(encodeValue(bytes));
    expect(Buffer.isBuffer(out)).toBe(true);
    expect([...(out as Buffer)]).toEqual([...bytes]);
  });

  test("an empty BLOB decodes as an empty Buffer", () => {
    const out = deserializeCell(encodeValue(new Uint8Array(0)));
    expect(Buffer.isBuffer(out)).toBe(true);
    expect((out as Buffer).length).toBe(0);
  });

  test("an infinite REAL decodes as the number it is", () => {
    expect(deserializeCell({ $: "nf", v: "Infinity" })).toBe(Number.POSITIVE_INFINITY);
    expect(deserializeCell({ $: "nf", v: "-Infinity" })).toBe(Number.NEGATIVE_INFINITY);
  });

  test("null, strings, numbers and booleans pass through unchanged", () => {
    expect(deserializeCell(encodeValue(null))).toBe(null);
    expect(deserializeCell(encodeValue("雪🚀"))).toBe("雪🚀");
    expect(deserializeCell(encodeValue(42.5))).toBe(42.5);
    expect(deserializeCell(encodeValue(true))).toBe(true);
  });

  test("nested arrays and records keep their shape and their tagged cells", () => {
    const value = { a: [1, BigInt(2)], b: { blob: Uint8Array.from([1, 2, 3]) } };
    const out = deserializeCell(encodeValue(value)) as { a: unknown[]; b: { blob: Buffer } };
    expect(out.a[0]).toBe(1);
    expect(out.a[1]).toBe(2);
    expect(Buffer.isBuffer(out.b.blob)).toBe(true);
    expect([...out.b.blob]).toEqual([1, 2, 3]);
  });

  test("a row whose columns are $ and v, or named like the old tags, is not reinterpreted", () => {
    const lookalike = { $: "i64", v: "9" };
    expect(encodeValue(lookalike)).toEqual({ $: "obj", v: lookalike });
    expect(deserializeCell(encodeValue(lookalike))).toEqual(lookalike);
    expect(deserializeCell({ __libredb_sqlite_bigint: "1" })).toEqual({ __libredb_sqlite_bigint: "1" });
    expect(deserializeCell({ __libredb_sqlite_bytes: "AA==" })).toEqual({ __libredb_sqlite_bytes: "AA==" });
  });

  test("a malformed wire value is refused by the codec, never read as data", () => {
    expect(() => deserializeCell({ $: "i64", v: "01" })).toThrow(ValueCodecError);
    expect(() => deserializeCell({ $: "ts", v: "x" })).toThrow(ValueCodecError);
  });
});
