import { describe, expect, test } from "bun:test";
import { SPARK_RESULT_BYTE_BUDGET } from "@/lib/db/providers/sql/spark/constants";
import { SPARK_ERROR_SENTENCES, SparkError } from "@/lib/db/providers/sql/spark/errors";
import { float32Number, variantJson } from "@/lib/db/providers/sql/spark/variant";

// Hand-built Variant values (parquet-format VariantEncoding.md at 37b6e8b), every size 1 byte unless named.
// BigInt(...) rather than literals: the repository's TypeScript target, ES2017, has no BigInt literal.
const utf8 = (text: string) => Array.from(new TextEncoder().encode(text));
const le = (value: number | bigint, size: number) =>
  Array.from({ length: size }, (_, index) =>
    Number((BigInt.asUintN(size * 8, BigInt(value)) >> BigInt(8 * index)) & BigInt(0xff)),
  );
/** Metadata version 1, offsets of `offsetSize` bytes. */
function meta(names: readonly string[], offsetSize = 1): Uint8Array {
  const bytes = names.map(utf8);
  const offsets = [0];
  for (const name of bytes) offsets.push(offsets[offsets.length - 1] + name.length);
  return Uint8Array.from([
    0x01 | ((offsetSize - 1) << 6),
    ...le(names.length, offsetSize),
    ...offsets.flatMap((offset) => le(offset, offsetSize)),
    ...bytes.flat(),
  ]);
}
const primitive = (id: number, payload: number[] = []) => Uint8Array.from([id << 2, ...payload]);
const shortString = (text: string) => Uint8Array.from([(utf8(text).length << 2) | 1, ...utf8(text)]);
/** An array with offsets of `offsetSize` bytes, its count in 4 bytes when `large`. */
function array(items: readonly Uint8Array[], offsetSize = 1, large = false): Uint8Array {
  const offsets = [0];
  for (const item of items) offsets.push(offsets[offsets.length - 1] + item.length);
  return Uint8Array.from([
    ((((large ? 1 : 0) << 2) | (offsetSize - 1)) << 2) | 3,
    ...le(items.length, large ? 4 : 1),
    ...offsets.flatMap((offset) => le(offset, offsetSize)),
    ...items.flatMap((item) => Array.from(item)),
  ]);
}
/** An object with field ids of `idSize` bytes and offsets of `offsetSize` bytes, its count in 4 bytes when `large`. */
function object(
  fields: readonly (readonly [number, Uint8Array])[],
  idSize = 1,
  offsetSize = 1,
  large = false,
): Uint8Array {
  const offsets = [0];
  for (const [, item] of fields) offsets.push(offsets[offsets.length - 1] + item.length);
  return Uint8Array.from([
    ((((large ? 1 : 0) << 4) | ((idSize - 1) << 2) | (offsetSize - 1)) << 2) | 2,
    ...le(fields.length, large ? 4 : 1),
    ...fields.flatMap(([id]) => le(id, idSize)),
    ...offsets.flatMap((offset) => le(offset, offsetSize)),
    ...fields.flatMap(([, item]) => Array.from(item)),
  ]);
}
/** An object of two fields that both point at the same nested value, the encoding allowing any field offsets. */
function shared(child: Uint8Array): Uint8Array {
  return Uint8Array.from([0x02, 2, 0, 1, 0, 0, child.length, ...child]);
}
/** That object repeated to depth 64: 449 bytes that stand for a text of 2^64 nulls. */
function deepShared(): Uint8Array {
  let value: Uint8Array = primitive(0);
  for (let level = 0; level < 64; level += 1) value = shared(value);
  return value;
}
const NO_NAMES = meta([]);
const BIG = 1_000_000;
const json = (value: Uint8Array, metadata: Uint8Array = NO_NAMES) => variantJson(value, metadata, BIG);
const float32Bytes = (value: number) => {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value, true);
  return Array.from(new Uint8Array(view.buffer));
};
const float64Bytes = (value: number) => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, true);
  return Array.from(new Uint8Array(view.buffer));
};

/**
 * Runs `decode` and counts the decoder's steps: every offset or length it reads passes one bounds check, which calls
 * Number.isInteger once, so the calls count the reads. Past `limit` steps the count stops the decode with an error, so
 * a decoder whose work outgrows its bound fails at once instead of running on.
 */
function stepsOf<T>(limit: number, decode: () => T): { readonly answer: T; readonly steps: number } {
  const isInteger = Number.isInteger;
  let steps = 0;
  Number.isInteger = (value: unknown): boolean => {
    steps += 1;
    if (steps > limit) throw new Error(`the decoder took more than ${limit} steps`);
    return isInteger(value);
  };
  try {
    const answer = decode();
    return { answer, steps };
  } finally {
    Number.isInteger = isInteger;
  }
}

/** Expects the value to be refused as unreadable, with the sentence that names the Variant encoding. */
function refused(value: Uint8Array, metadata: Uint8Array = NO_NAMES): void {
  let caught: unknown;
  try {
    variantJson(value, metadata, BIG);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(SparkError);
  expect((caught as SparkError).category).toBe("unreadable");
  expect((caught as SparkError).message).toBe(
    SPARK_ERROR_SENTENCES.unreadable("a VARIANT value that does not follow the Variant encoding"),
  );
}

describe("variantJson: primitives", () => {
  test("null, booleans, integers, doubles and floats", () => {
    expect(json(primitive(0))).toBe("null");
    expect(json(primitive(1))).toBe("true");
    expect(json(primitive(2))).toBe("false");
    expect(json(primitive(3, le(-5, 1)))).toBe("-5");
    expect(json(primitive(4, le(-300, 2)))).toBe("-300");
    expect(json(primitive(5, le(70000, 4)))).toBe("70000");
    expect(json(primitive(6, le(BigInt("9007199254740993"), 8)))).toBe("9007199254740993");
    expect(json(primitive(6, le(BigInt("-9223372036854775808"), 8)))).toBe("-9223372036854775808");
    expect(json(primitive(7, float64Bytes(1.5)))).toBe("1.5");
    // A double is written as JavaScript writes it, where Java would write 1.0 and 1.0E21.
    expect(json(primitive(7, float64Bytes(1)))).toBe("1");
    expect(json(primitive(7, float64Bytes(1e21)))).toBe("1e+21");
    expect(json(primitive(7, float64Bytes(Number.NaN)))).toBe('"NaN"');
    expect(json(primitive(7, float64Bytes(Number.POSITIVE_INFINITY)))).toBe('"Infinity"');
    expect(json(primitive(14, float32Bytes(0.1)))).toBe("0.1");
    expect(json(primitive(14, float32Bytes(Number.NEGATIVE_INFINITY)))).toBe('"-Infinity"');
  });

  test("decimals keep their scale's digits, signs included", () => {
    expect(json(primitive(8, [2, ...le(110, 4)]))).toBe("1.10");
    expect(json(primitive(9, [3, ...le(-1234567, 8)]))).toBe("-1234.567");
    expect(json(primitive(10, [0, ...le(-(BigInt(10) ** BigInt(30)), 16)]))).toBe(`-1${"0".repeat(30)}`);
    expect(json(primitive(10, [38, ...le(BigInt(`1${"2".repeat(37)}`), 16)]))).toBe(`0.1${"2".repeat(37)}`);
    expect(json(primitive(8, [4, ...le(5, 4)]))).toBe("0.0005");
    expect(json(primitive(8, [38, ...le(0, 4)]))).toBe(`0.${"0".repeat(38)}`);
  });

  test("dates and timestamps in ISO 8601 with T, the zoned one with +00:00", () => {
    expect(json(primitive(11, le(19782, 4)))).toBe('"2024-02-29"');
    expect(json(primitive(12, le(1_709_164_800_123_450, 8)))).toBe('"2024-02-29T00:00:00.12345+00:00"');
    expect(json(primitive(12, le(-1, 8)))).toBe('"1969-12-31T23:59:59.999999+00:00"');
    expect(json(primitive(13, le(0, 8)))).toBe('"1970-01-01T00:00:00"');
  });

  test("binary in base64, strings long and short, escaped as JSON", () => {
    expect(json(primitive(15, [...le(3, 4), 1, 2, 3]))).toBe('"AQID"');
    expect(json(primitive(15, le(0, 4)))).toBe('""');
    expect(json(primitive(16, [...le(utf8('a"b').length, 4), ...utf8('a"b')]))).toBe('"a\\"b"');
    expect(json(shortString("héllo"))).toBe('"héllo"');
    expect(json(shortString("a\nb\\"))).toBe('"a\\nb\\\\"');
  });

  test("a string that starts with U+FEFF keeps it", () => {
    expect(json(shortString("\uFEFFa"))).toBe('"\uFEFFa"');
    expect(json(primitive(16, [...le(utf8("\uFEFF").length, 4), ...utf8("\uFEFF")]))).toBe('"\uFEFF"');
  });
});

describe("variantJson: objects and arrays", () => {
  test("object fields in stored order with their dictionary names, arrays in order", () => {
    const names = meta(["a", "b"]);
    const value = object([
      [1, primitive(5, le(1, 4))],
      [0, array([primitive(0), shortString("x")])],
    ]);
    expect(variantJson(value, names, BIG)).toBe('{"b":1,"a":[null,"x"]}');
    expect(JSON.parse(variantJson(value, names, BIG) ?? "")).toStrictEqual({ b: 1, a: [null, "x"] });
  });

  test("a value and a metadata that start inside a larger buffer, as Arrow's binary children hand them over", () => {
    const names = meta(["a"]);
    const value = object([
      [
        0,
        array([
          primitive(5, le(70000, 4)),
          primitive(7, float64Bytes(1.5)),
          primitive(10, [2, ...le(-12345, 16)]),
          primitive(15, [...le(2, 4), 1, 2]),
          shortString("x"),
        ]),
      ],
    ]);
    const host = new Uint8Array(3 + value.length + names.length + 5).fill(0xff);
    host.set(value, 3);
    host.set(names, 3 + value.length);
    const inner = host.subarray(3, 3 + value.length);
    const innerNames = host.subarray(3 + value.length, 3 + value.length + names.length);
    expect(variantJson(inner, innerNames, BIG)).toBe('{"a":[70000,1.5,-123.45,"AQI=","x"]}');
  });

  test("an empty object and an empty array", () => {
    expect(json(object([]))).toBe("{}");
    expect(json(array([]))).toBe("[]");
  });

  test("wider layouts: 4-byte counts, ids and offsets of 2 to 4 bytes, metadata offsets of 2 and 4 bytes", () => {
    for (const offsetSize of [2, 4]) {
      const names = meta(["\uFEFFk", 'v"'], offsetSize);
      const value = object(
        [
          [0, primitive(3, le(7, 1))],
          [1, array([shortString("x"), primitive(1)], 4, true)],
        ],
        2,
        3,
        true,
      );
      expect(variantJson(value, names, BIG)).toBe('{"\uFEFFk":7,"v\\"":["x",true]}');
    }
    expect(json(object([[0, primitive(0)]], 3, 2), meta(["a"]))).toBe('{"a":null}');
    expect(json(object([[0, primitive(0)]], 4, 1), meta(["a"]))).toBe('{"a":null}');
    expect(json(array([primitive(2)], 2))).toBe("[false]");
    expect(json(array([primitive(2)], 3))).toBe("[false]");
  });

  test("a value nested 64 levels deep is read, and one nested 65 levels deep is refused", () => {
    let value: Uint8Array = primitive(0);
    for (let level = 0; level < 64; level += 1) value = array([value]);
    expect(json(value)).toBe(`${"[".repeat(64)}null${"]".repeat(64)}`);
    refused(array([value]));
  });
});

describe("variantJson: the text bound", () => {
  // Each test bounds the decoder's steps by maxChars, which no wall clock can make flaky; the lower bound shows the count
  // measured a decode that wrote up to maxChars, at about one step for every two characters of this value's text.
  test("an object whose two fields share one nested value, repeated to depth 64, answers undefined at maxChars after no more steps than maxChars", () => {
    const { answer, steps } = stepsOf(10_000, () => variantJson(deepShared(), meta(["a", "b"]), 10_000));
    expect(answer).toBeUndefined();
    expect(steps).toBeGreaterThan(10_000 / 4);
  });

  test("the same value at the statement's whole decoded budget answers undefined after no more steps than that budget", () => {
    const { answer, steps } = stepsOf(SPARK_RESULT_BYTE_BUDGET, () =>
      variantJson(deepShared(), meta(["a", "b"]), SPARK_RESULT_BYTE_BUDGET),
    );
    expect(answer).toBeUndefined();
    expect(steps).toBeGreaterThan(SPARK_RESULT_BYTE_BUDGET / 4);
  });

  test("a text of more parts than the writer joins at once comes back whole and in order", () => {
    const items = Array.from({ length: 5_000 }, (_, index) => String(index));
    expect(variantJson(array(items.map(shortString), 4, true), NO_NAMES, BIG)).toBe(JSON.stringify(items));
  });

  test("the same shape at depth 2 decodes whole", () => {
    expect(variantJson(shared(shared(primitive(0))), meta(["a", "b"]), BIG)).toBe(
      '{"a":{"a":null,"b":null},"b":{"a":null,"b":null}}',
    );
  });

  test("a text exactly at maxChars is whole, and one character past it is undefined", () => {
    expect(variantJson(shortString("abc"), NO_NAMES, 5)).toBe('"abc"');
    expect(variantJson(shortString("abcd"), NO_NAMES, 5)).toBeUndefined();
    const whole = '{"a":{"a":null,"b":null},"b":{"a":null,"b":null}}';
    const value = shared(shared(primitive(0)));
    expect(variantJson(value, meta(["a", "b"]), whole.length)).toBe(whole);
    expect(variantJson(value, meta(["a", "b"]), whole.length - 1)).toBeUndefined();
    // A binary's base64 text is measured before it is built: four characters for every three bytes, and the quotes.
    const binary = primitive(15, [...le(4, 4), 1, 2, 3, 4]);
    expect(variantJson(binary, NO_NAMES, 10)).toBe('"AQIDBA=="');
    expect(variantJson(binary, NO_NAMES, 9)).toBeUndefined();
    expect(variantJson(primitive(0), NO_NAMES, 1)).toBeUndefined();
    // A budget spent to exactly 0 has room for no text: the caller cuts before the row.
    expect(variantJson(primitive(0), NO_NAMES, 0)).toBeUndefined();
  });
});

describe("variantJson: the caller's budget", () => {
  test("a maxChars that is not a non-negative safe integer is the caller's defect, raised", () => {
    for (const maxChars of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, 2 ** 53]) {
      let caught: unknown;
      try {
        variantJson(primitive(0), NO_NAMES, maxChars);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(TypeError);
      expect((caught as TypeError).message).toBe(
        `variantJson: maxChars must be a non-negative safe integer, not ${maxChars}`,
      );
    }
  });
});

describe("variantJson: refusals, each offset and length checked", () => {
  test("an undefined type id, and TIME, the nanosecond timestamps and UUID (21 to 24 at 37b6e8b)", () => {
    for (const id of [17, 18, 19, 20, 21, 22, 23, 24, 63]) refused(primitive(id, le(0, 16)));
  });

  test("truncated values, strings, binaries, objects and arrays", () => {
    refused(new Uint8Array(0));
    refused(primitive(5, [1, 2]));
    refused(primitive(6, le(0, 7)));
    refused(primitive(10, [0, ...le(0, 15)]));
    refused(primitive(8, []));
    refused(primitive(16, [...le(100, 4), 1]));
    refused(primitive(15, le(5, 2)));
    refused(Uint8Array.from([0x03, 3, 0, 1]));
    refused(Uint8Array.from([0x02, 2, 0]));
    refused(Uint8Array.from([(5 << 2) | 1, 0x61]));
    refused(object([[0, primitive(0)]]).subarray(0, 4));
    refused(array([primitive(0)], 1, true).subarray(0, 3));
  });

  test("a field offset that points past the end of the value", () => {
    refused(Uint8Array.from([0x03, 1, 200, 201, 0x00]));
    refused(Uint8Array.from([0x02, 1, 0, 9, 10, 0x00]), meta(["a"]));
  });

  test("a binary whose length runs past the end of the value", () => {
    refused(primitive(15, [...le(5, 4), 1, 2]));
  });

  test("an empty array and an empty object without their one offset", () => {
    refused(Uint8Array.from([0x03, 0]));
    refused(Uint8Array.from([0x02, 0]));
  });

  test("a field id equal to the dictionary's size, whose name would come from the dictionary's bytes", () => {
    refused(object([[1, primitive(0)]]), Uint8Array.from([0x01, 1, 0, 1, 0x02, 0x61]));
  });

  test("a field id past the dictionary, metadata of another version or cut short, invalid UTF-8, a scale past 38", () => {
    refused(object([[3, primitive(0)]]), meta(["a"]));
    refused(primitive(0), Uint8Array.from([0x02, 0, 0]));
    refused(primitive(0), new Uint8Array(0));
    refused(primitive(0), Uint8Array.from([0x01, 5, 0]));
    refused(object([[0, primitive(0)]]), Uint8Array.from([0x01, 1, 2, 1, 0x61]));
    refused(object([[0, primitive(0)]]), Uint8Array.from([0x01, 1, 0, 5, 0x61]));
    refused(object([[0, primitive(0)]]), Uint8Array.from([0x01, 1, 0, 1, 0xff]));
    refused(shortString("a").map((byte, index) => (index === 1 ? 0xff : byte)));
    refused(primitive(16, [...le(3, 4), 0xed, 0xa0, 0x80]));
    refused(primitive(8, [39, ...le(1, 4)]));
  });

  test("an object that holds one field name twice, by one dictionary id or by two", () => {
    refused(
      object([
        [0, primitive(0)],
        [0, primitive(1)],
      ]),
      meta(["a"]),
    );
    refused(
      object([
        [0, primitive(0)],
        [1, primitive(1)],
      ]),
      meta(["a", "a"]),
    );
    expect(json(object([[0, object([[0, primitive(0)]])]]), meta(["a"]))).toBe('{"a":{"a":null}}');
  });

  test("a decimal of more than 38 digits, the encoding storing a scale and an unscaled value but no precision", () => {
    const nines = BigInt(10) ** BigInt(38) - BigInt(1);
    expect(json(primitive(10, [0, ...le(nines, 16)]))).toBe("9".repeat(38));
    expect(json(primitive(10, [0, ...le(-nines, 16)]))).toBe(`-${"9".repeat(38)}`);
    refused(primitive(10, [0, ...le(nines + BigInt(1), 16)]));
    refused(primitive(10, [0, ...le(-nines - BigInt(1), 16)]));
    refused(primitive(10, [38, ...le((BigInt(1) << BigInt(127)) - BigInt(1), 16)]));
  });
});

describe("float32Number", () => {
  test("the shortest decimal that reads back as the same float32", () => {
    expect(float32Number(Math.fround(0.1))).toBe(0.1);
    expect(float32Number(Math.fround(3.4028234663852886e38))).toBe(3.4028235e38);
    expect(float32Number(Math.fround(-1.5))).toBe(-1.5);
    expect(float32Number(Math.fround(1e-45))).toBe(1e-45);
    expect(float32Number(Number.NaN)).toBeNaN();
    expect(float32Number(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
  });

  test("both zeros keep their sign", () => {
    expect(Object.is(float32Number(0), 0)).toBe(true);
    expect(Object.is(float32Number(-0), -0)).toBe(true);
  });

  test("at a power of two the shortest decimal can lie on the far side of the nearest one", () => {
    // The float32 below a power of two is half as far away as the one above, so fewer decimals read back below it.
    expect(float32Number(2 ** -96)).toBe(1.2621775e-29);
    expect(float32Number(2 ** 87)).toBe(1.5474251e26);
    expect(float32Number(-(2 ** 90))).toBe(-1.2379401e27);
  });

  test("a float32 that needs nine digits", () => {
    expect(float32Number(Math.fround(1023.99994))).toBe(1023.99994);
    expect(Math.fround(1023.9999)).not.toBe(Math.fround(1023.99994));
  });
});
