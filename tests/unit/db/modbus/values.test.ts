/**
 * Value decoding. The rule under test is that a wrong order is not an error but a plausible wrong
 * number, which is why no order has a default.
 *
 * The expected numbers below are the ones the issue author measured on the pymodbus device server:
 * a float32 holding 1.5 laid out in each of the four 32 bit orders reads back as 1.5 only under its
 * own order, and as 2.2869e-41, -2.984375 or 6.8965e-41 under the others. They are asserted here so
 * that a change to the decoder that quietly "fixes" one order is caught.
 */
import { describe, expect, test } from "bun:test";
import {
  applyScale,
  decodeBits,
  decodeScalar,
  ModbusDecodeError,
  orderedBytes,
  type Layout,
} from "@/lib/db/providers/industrial/modbus/values";

const HF: Layout = { wordOrder: "high_first", byteOrder: "high_first" };
const LF_WORD: Layout = { wordOrder: "low_first", byteOrder: "high_first" };
const LF_BYTE: Layout = { wordOrder: "high_first", byteOrder: "low_first" };
const LF_BOTH: Layout = { wordOrder: "low_first", byteOrder: "low_first" };

describe("a wrong order is a plausible wrong number, not an error", () => {
  /** pymodbus writes float32 1.5 as 3fc0 0000, high word first. */
  const words = [0x3fc0, 0x0000];

  test("the device's own order reads 1.5", () => {
    expect(decodeScalar("float32", words, HF)).toBeCloseTo(1.5, 6);
  });

  test("each of the other three orders reads a different number and throws nothing", () => {
    const wrong = [LF_WORD, LF_BYTE, LF_BOTH].map((l) => decodeScalar("float32", words, l) as number);
    for (const value of wrong) expect(Number.isNaN(value)).toBe(false);
    expect(new Set([1.5, ...wrong]).size).toBe(4);
    expect(wrong).toContainEqual(-2.984375);
  });
});

describe("64 bit integers are exact, which a number could not be", () => {
  /**
   * `BigInt("...")` rather than a literal: the repository targets ES2017 and `tsc` refuses a BigInt
   * literal there (TS2737). `bun test` does not typecheck, so five of these passed their tests
   * while the code did not compile. The value is the same; the spelling is what the target allows.
   */
  test("the measured uint64 decodes to its exact value as a bigint", () => {
    const words = [0x0102, 0x0304, 0x0506, 0x0708];
    const value = decodeScalar("uint64", words, HF);
    expect(typeof value).toBe("bigint");
    expect(value).toBe(BigInt("72623859790382856"));
    expect(Number(value) > Number.MAX_SAFE_INTEGER).toBe(true);
  });

  /**
   * TWO cases, and they have to disagree. The first version of this block tested `uint64` only, and
   * a mutation proved what that costs: turning `int64` into a `number` left the suite green, so the
   * rule "a 64 bit integer decodes as a bigint" was asserted for one of the two types and held for
   * neither. The pair below reads the SAME four words two ways and the answers differ by the full
   * unsigned range, which is the only shape of test that can tell the two decoders apart.
   */
  test("the same words decode differently as int64 and as uint64, both as bigint", () => {
    const words = [0xffff, 0xffff, 0xffff, 0xffff];
    const signed = decodeScalar("int64", words, HF);
    const unsigned = decodeScalar("uint64", words, HF);
    expect(typeof signed).toBe("bigint");
    expect(typeof unsigned).toBe("bigint");
    expect(signed).toBe(BigInt("-1"));
    expect(unsigned).toBe(BigInt("18446744073709551615"));
    expect(signed).not.toBe(unsigned);
  });

  test("int64 reads a negative that a number could not hold exactly", () => {
    const value = decodeScalar("int64", [0x8000, 0x0000, 0x0000, 0x0000], HF);
    expect(typeof value).toBe("bigint");
    expect(value).toBe(BigInt("-9223372036854775808"));
  });

  test("a scale or an offset is refused on a bigint rather than silently losing exactness", () => {
    expect(() => applyScale(BigInt("72623859790382856"), 0.1)).toThrow(ModbusDecodeError);
    expect(() => applyScale(BigInt("72623859790382856"), undefined, 1)).toThrow(ModbusDecodeError);
    expect(applyScale(BigInt("72623859790382856"))).toBe(BigInt("72623859790382856"));
  });
});

describe("the narrow types", () => {
  test("int16 reads a negative", () => {
    expect(decodeScalar("int16", [0xffce], HF)).toBe(-50);
  });
  test("uint16 reads the same words as positive", () => {
    expect(decodeScalar("uint16", [0xffce], HF)).toBe(65486);
  });
  test("int32 and uint32 differ on the same words", () => {
    expect(decodeScalar("int32", [0xffff, 0xffff], HF)).toBe(-1);
    expect(decodeScalar("uint32", [0xffff, 0xffff], HF)).toBe(4294967295);
  });
  test("float64 reads pi from the measured layout", () => {
    expect(decodeScalar("float64", [0x4009, 0x21fb, 0x5444, 0x2d18], HF)).toBeCloseTo(Math.PI, 12);
  });
});

describe("what the decoder refuses", () => {
  test("a register that is not a 16 bit unsigned word", () => {
    for (const bad of [-1, 0x10000, 1.5, Number.NaN]) {
      expect(() => orderedBytes([bad], HF)).toThrow(ModbusDecodeError);
    }
  });
  test("a word count that does not match the type", () => {
    expect(() => decodeScalar("uint32", [1], HF)).toThrow(/needs 2/);
    expect(() => decodeScalar("uint16", [1, 2], HF)).toThrow(/needs 1/);
  });
  test("an unknown type", () => {
    expect(() => decodeScalar("uint24" as never, [1], HF)).toThrow(ModbusDecodeError);
  });
});

describe("scale and offset on a number", () => {
  /**
   * One case is enough here only because the two candidate formulas disagree ON THIS DATA, and the
   * test says so rather than leaving a reader to check: value * scale + offset is 15, while
   * (value + offset) * scale would be 10.5. The second assertion is what makes the first one mean
   * what its name says.
   */
  test("the order is value times scale plus offset, not the other way round", () => {
    expect(applyScale(100, 0.1, 5)).toBeCloseTo(15, 9);
    expect(applyScale(100, 0.1, 5)).not.toBeCloseTo(10.5, 9);
  });
  test("both are optional and default to identity", () => {
    expect(applyScale(42)).toBe(42);
  });
});

describe("bit packing of MB 6.1", () => {
  /**
   * The data here is NOT 0b00000101, and the reason is the point of the test. The low three bits of
   * that byte are 101, which reads the same in either direction, so a test using it cannot tell the
   * order it names from its reverse: it would stay green against a decoder that packed bits the
   * other way. 0b00000110 is 011 from the low end and 110 from the high end, so it distinguishes.
   */
  test("the first byte carries the lowest address in its least significant bit", () => {
    expect(decodeBits(Buffer.from([0b00000110]), 3)).toEqual([false, true, true]);
    expect(decodeBits(Buffer.from([0b00000110]), 3)).not.toEqual([true, true, false]);
  });

  test("the second byte carries addresses 8 and up, in the same direction", () => {
    expect(decodeBits(Buffer.from([0x00, 0b00000110]), 11)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      true,
      true,
    ]);
  });
  test("quantity decides how many bits are read, not the byte count", () => {
    expect(decodeBits(Buffer.from([0xff, 0xff]), 9)).toHaveLength(9);
  });
  test("too few bytes for the quantity is refused", () => {
    expect(() => decodeBits(Buffer.from([0xff]), 9)).toThrow(ModbusDecodeError);
  });
});
